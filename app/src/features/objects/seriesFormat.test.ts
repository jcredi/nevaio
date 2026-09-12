/**
 * Tests for the `series/<TILE>/<YYYY-MM>.bin` cell decoder - the frontend
 * mirror of `pipeline/src/nevaio_pipeline/object_series.py`. Every case here
 * has a named counterpart in that module's own test suite
 * (`pipeline/tests/test_object_series.py`); this file exists so the two
 * decoders cannot silently drift.
 *
 * Run with `npm test` (Node runs the TypeScript directly).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CELL_SIZE,
  CLOUD_GF_BYTE,
  SeriesFormatError,
  cellOffset,
  dayIndexOfIso,
  decodeCell,
  decodeMonthBuffer,
  monthKey,
  monthsBetween,
  objectMonthRange,
  yearMonthOfIso,
} from "./seriesFormat.ts";

describe("decodeCell", () => {
  it("decodes a valid mark: GF 0-100, QA 0-3, age 0-14", () => {
    // packed = (age << 2) | quality = (5 << 2) | 2 = 22
    const cell = decodeCell(63, 22);
    assert.deepEqual(cell, { state: "valid", gf: 63, quality: 2, ageDays: 5 });
  });

  it("decodes GF 0 and GF 100 as valid, the boundary values", () => {
    assert.equal(decodeCell(0, 0).state, "valid");
    assert.equal(decodeCell(100, 0).state, "valid");
  });

  it("decodes the cloud sentinel (205) regardless of the packed byte", () => {
    const cell = decodeCell(CLOUD_GF_BYTE, 0b111111);
    assert.deepEqual(cell, { state: "cloud", gf: null, quality: null, ageDays: null });
  });

  it("decodes any other out-of-range GF byte as no_data (water, no-data, unrecognized)", () => {
    assert.equal(decodeCell(210, 0).state, "no_data"); // water
    assert.equal(decodeCell(255, 60).state, "no_data"); // NODATA / "no product that day"
    assert.equal(decodeCell(150, 0).state, "no_data"); // unrecognized
  });

  it("decodes GF present but age code 15 (n/a) as stale, keeping GF and quality", () => {
    const packed = (15 << 2) | 1;
    const cell = decodeCell(42, packed);
    assert.deepEqual(cell, { state: "stale", gf: 42, quality: 1, ageDays: null });
  });

  it("stale wins over an otherwise-valid-looking GF when age is the sentinel, even at GF 0", () => {
    assert.equal(decodeCell(0, 15 << 2).state, "stale");
  });

  it("rejects a byte outside 0-255", () => {
    assert.throws(() => decodeCell(-1, 0), SeriesFormatError);
    assert.throws(() => decodeCell(0, 256), SeriesFormatError);
    assert.throws(() => decodeCell(1.5, 0), SeriesFormatError);
  });
});

describe("decodeMonthBuffer", () => {
  it("decodes a whole buffer in day order", () => {
    // Day 0: valid GF=10 age=0 q=0. Day 1: cloud. Day 2: no_data (all-NODATA cell).
    const bytes = Uint8Array.from([10, 0, CLOUD_GF_BYTE, 0, 255, 15 << 2]);
    const cells = decodeMonthBuffer(bytes);
    assert.equal(cells.length, 3);
    assert.equal(cells[0].state, "valid");
    assert.equal(cells[1].state, "cloud");
    assert.equal(cells[2].state, "no_data");
  });

  it("accepts an empty buffer (zero days) as zero cells", () => {
    assert.deepEqual(decodeMonthBuffer(new Uint8Array(0)), []);
  });

  it("rejects a buffer whose length is not a whole number of cells", () => {
    assert.throws(() => decodeMonthBuffer(new Uint8Array(3)), SeriesFormatError);
    assert.throws(() => decodeMonthBuffer(new Uint8Array(1)), SeriesFormatError);
  });

  it("CELL_SIZE matches the pipeline's own constant", () => {
    assert.equal(CELL_SIZE, 2);
  });
});

describe("offset arithmetic", () => {
  it("computes a 31-day month's range as slot * 62 bytes, 62 bytes long", () => {
    assert.deepEqual(objectMonthRange(0, 31), { start: 0, length: 62 });
    assert.deepEqual(objectMonthRange(3, 31), { start: 186, length: 62 });
  });

  it("computes one day's offset within a month buffer", () => {
    assert.equal(cellOffset(0, 0, 31), 0);
    assert.equal(cellOffset(0, 30, 31), 60);
    assert.equal(cellOffset(1, 0, 31), 62);
  });

  it("rejects an out-of-range day index or a negative slot", () => {
    assert.throws(() => cellOffset(0, 31, 31), SeriesFormatError);
    assert.throws(() => cellOffset(-1, 0, 31), SeriesFormatError);
    assert.throws(() => objectMonthRange(-1, 31), SeriesFormatError);
  });
});

describe("calendar helpers", () => {
  it("splits an ISO date into year/month and a 0-based day index", () => {
    assert.deepEqual(yearMonthOfIso("2026-09-12"), { year: 2026, month: 9 });
    assert.equal(dayIndexOfIso("2026-09-12"), 11);
    assert.equal(dayIndexOfIso("2026-09-01"), 0);
  });

  it("formats a month key matching the .bin filename stem", () => {
    assert.equal(monthKey({ year: 2026, month: 9 }), "2026-09");
    assert.equal(monthKey({ year: 2026, month: 1 }), "2026-01");
  });

  it("enumerates every month touched by a range, including a range spanning a year boundary", () => {
    assert.deepEqual(monthsBetween("2026-09-12", "2026-09-12"), [{ year: 2026, month: 9 }]);
    assert.deepEqual(monthsBetween("2025-11-20", "2026-02-05"), [
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });
});
