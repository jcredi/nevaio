/**
 * Tests for the snow data tile decoder (spec section 8.4).
 *
 * These deliberately encode pixels the way
 * `pipeline/src/nevaio_pipeline/data_tiles.py` does, by hand, rather than
 * importing anything: the point is to assert that this side of the contract
 * agrees with the written wire format. `pipeline/tests/test_data_tiles.py`
 * asserts the same format from the encoder's side, and the two files are the
 * only check that the halves have not drifted apart.
 *
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGE_NOT_APPLICABLE,
  ALPHA_OPAQUE,
  DATA_TILE_SIZE,
  DATA_TILE_ZOOM,
  MAX_AGE_DAYS,
  NO_VALUE,
  QUALITY_LABELS,
  SnowDataState,
  STATE_LABELS,
  decodeAt,
  decodePixel,
  pixelAddressFor,
} from "./snowDataTile.ts";

/** Build a pixel exactly as `data_tiles.py` would. */
function encode(options: {
  fsc?: number;
  age?: number;
  quality?: number;
  state: SnowDataState;
  alpha?: number;
}): [number, number, number, number] {
  const { fsc = NO_VALUE, age = AGE_NOT_APPLICABLE, quality = 0, state, alpha = ALPHA_OPAQUE } = options;
  return [fsc, age, (quality & 0b11) | (state << 2), alpha];
}

describe("decodePixel", () => {
  it("reads a confirmed 0% as a real value, not an absence", () => {
    // The reason this whole format exists: on the visual raster a confirmed 0%
    // pixel is indistinguishable from cloud, water and no-data (spec 5.4).
    const cell = decodePixel(...encode({ fsc: 0, age: 0, quality: 1, state: SnowDataState.Valid }));
    assert.equal(cell.fsc, 0);
    assert.equal(cell.state, SnowDataState.Valid);
    assert.equal(cell.quality, 1);
    assert.equal(cell.ageDays, 0);
  });

  it("round-trips the whole percentage range", () => {
    for (const value of [0, 1, 50, 99, 100]) {
      const cell = decodePixel(...encode({ fsc: value, age: 2, state: SnowDataState.Valid }));
      assert.equal(cell.fsc, value);
    }
  });

  it("round-trips every quality tier", () => {
    for (const tier of [0, 1, 2, 3]) {
      const cell = decodePixel(...encode({ fsc: 10, age: 0, quality: tier, state: SnowDataState.Valid }));
      assert.equal(cell.quality, tier);
    }
  });

  it("round-trips the age range and marks anything else absent", () => {
    for (const age of [0, 1, 14, MAX_AGE_DAYS]) {
      const cell = decodePixel(...encode({ fsc: 10, age, state: SnowDataState.Valid }));
      assert.equal(cell.ageDays, age);
    }
    const absent = decodePixel(...encode({ state: SnowDataState.Cloud }));
    assert.equal(absent.ageDays, null);
  });

  it("keeps the four missing states distinct from each other and from 0%", () => {
    const states = [
      SnowDataState.Cloud,
      SnowDataState.Water,
      SnowDataState.NoData,
      SnowDataState.Stale,
    ];
    for (const state of states) {
      const cell = decodePixel(...encode({ state }));
      assert.equal(cell.state, state);
      assert.equal(cell.fsc, null, `state ${state} must carry no percentage`);
    }
    assert.equal(new Set(states).size, states.length);
  });

  it("never reports a stale pixel's percentage as a reading", () => {
    // The encoder does not publish one, but if it ever did, the state alone
    // must stop it being read as current.
    const cell = decodePixel(...encode({ fsc: 88, age: 30, state: SnowDataState.Stale }));
    assert.equal(cell.fsc, null);
    assert.equal(cell.state, SnowDataState.Stale);
  });

  it("rejects a non-opaque pixel instead of trusting rounded channels", () => {
    // canvas getImageData un-premultiplies by alpha, so below 255 the other
    // three channels come back rounded - silently. A quietly wrong snow
    // percentage is worse than an admitted unknown.
    const cell = decodePixel(...encode({ fsc: 50, age: 1, state: SnowDataState.Valid, alpha: 254 }));
    assert.equal(cell.fsc, null);
    assert.equal(cell.state, SnowDataState.NoData);
  });

  it("treats an unknown state code as no data rather than guessing", () => {
    const cell = decodePixel(10, 0, (5 << 2) | 1, ALPHA_OPAQUE);
    assert.equal(cell.state, SnowDataState.NoData);
    assert.equal(cell.fsc, null);
  });

  it("refuses an out-of-range percentage even when the state claims valid", () => {
    const cell = decodePixel(200, 0, SnowDataState.Valid << 2, ALPHA_OPAQUE);
    assert.equal(cell.fsc, null);
  });
});

describe("decodeAt", () => {
  it("reads the right pixel out of a buffer", () => {
    const pixels = new Uint8ClampedArray(DATA_TILE_SIZE * DATA_TILE_SIZE * 4);
    const [r, g, b, a] = encode({ fsc: 77, age: 4, quality: 2, state: SnowDataState.Valid });
    const target = (17 * DATA_TILE_SIZE + 5) * 4;
    pixels[target] = r;
    pixels[target + 1] = g;
    pixels[target + 2] = b;
    pixels[target + 3] = a;

    const cell = decodeAt(pixels, 5, 17);
    assert.equal(cell.fsc, 77);
    assert.equal(cell.ageDays, 4);
    assert.equal(cell.quality, 2);
  });

  it("returns unknown outside the tile rather than wrapping to another pixel", () => {
    const pixels = new Uint8ClampedArray(DATA_TILE_SIZE * DATA_TILE_SIZE * 4).fill(ALPHA_OPAQUE);
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [DATA_TILE_SIZE, 0],
      [0, DATA_TILE_SIZE],
    ]) {
      assert.equal(decodeAt(pixels, x, y).state, SnowDataState.NoData);
      assert.equal(decodeAt(pixels, x, y).fsc, null);
    }
  });

  it("returns unknown for a short buffer instead of reading past the end", () => {
    assert.equal(decodeAt(new Uint8ClampedArray(8), 100, 100).fsc, null);
  });
});

describe("pixelAddressFor", () => {
  it("puts Zermatt in the tile the published pyramid uses", () => {
    // z11/1068/728 - the tile actually fetched from R2 while sizing this
    // format on 2026-09-13.
    const address = pixelAddressFor(7.7492, 46.0207);
    assert.equal(address.z, DATA_TILE_ZOOM);
    assert.equal(address.x, 1068);
    assert.equal(address.y, 728);
    assert.ok(address.px >= 0 && address.px < DATA_TILE_SIZE);
    assert.ok(address.py >= 0 && address.py < DATA_TILE_SIZE);
  });

  it("moves east and south as longitude and latitude do", () => {
    const west = pixelAddressFor(7.0, 46.0);
    const east = pixelAddressFor(9.0, 46.0);
    const north = pixelAddressFor(8.0, 47.0);
    const south = pixelAddressFor(8.0, 45.0);
    assert.ok(east.x > west.x, "east must have a larger tile x");
    assert.ok(south.y > north.y, "south must have a larger tile y");
  });

  it("never produces a NaN or out-of-range pixel, even at the projection limits", () => {
    for (const [lon, lat] of [
      [0, 89],
      [0, -89],
      [-180, 0],
      [179.999, 0],
    ]) {
      const address = pixelAddressFor(lon, lat);
      for (const value of [address.x, address.y, address.px, address.py]) {
        assert.ok(Number.isFinite(value), `non-finite for ${lon},${lat}`);
      }
      assert.ok(address.px >= 0 && address.px < DATA_TILE_SIZE);
      assert.ok(address.py >= 0 && address.py < DATA_TILE_SIZE);
    }
  });
});

describe("labels", () => {
  it("names every state and quality tier, since the spec requires names not codes", () => {
    for (const state of [
      SnowDataState.Valid,
      SnowDataState.Cloud,
      SnowDataState.Water,
      SnowDataState.NoData,
      SnowDataState.Stale,
    ]) {
      assert.ok(STATE_LABELS[state].length > 0);
    }
    // Must match QUALITY_TIER_LABELS in ../objects/seriesFormat.ts: the same
    // tier must not be called two different things in two parts of one app.
    assert.deepEqual([...QUALITY_LABELS], ["High", "Medium", "Low", "Minimal"]);
  });
});
