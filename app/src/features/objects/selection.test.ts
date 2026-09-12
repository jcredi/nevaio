/**
 * Tests for the tap-to-record matching rule.
 *
 * Run with `npm test`. These are the cases that decide whether the panel can
 * show the wrong peak's snow history, which is the hazard the whole rule
 * exists to prevent - so "refuses to choose" is a passing outcome here, not a
 * missing feature.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ObjectRecord } from "./objectIndexSchema.ts";
import {
  AMBIGUITY_RATIO,
  SELECTION_MAX_METERS_PER_PIXEL,
  TAP_RADIUS_PIXELS,
  distanceMeters,
  resolveSelection,
} from "./selection.ts";

/** Real coordinates, so the distances in these tests are real distances. */
const DUFOURSPITZE: ObjectRecord = {
  id: "node/414760065",
  kind: "peak",
  name: "Dufourspitze",
  longitude: 7.866757,
  latitude: 45.936924,
  elevationMeters: 4634,
};
const NORDEND: ObjectRecord = {
  id: "node/414760066",
  kind: "peak",
  name: "Nordend",
  longitude: 7.869,
  latitude: 45.943,
  elevationMeters: 4609,
};
const CAPANNA_MARGHERITA: ObjectRecord = {
  id: "node/307196932",
  kind: "hut",
  name: "Capanna Regina Margherita",
  longitude: 7.876944,
  latitude: 45.926944,
  elevationMeters: 4554,
};

/** A scale comfortably inside the floor: MapLibre z14-ish at this latitude. */
const FINE = 3.4;

function tapAt(record: ObjectRecord, offsetMeters = 0) {
  // Offset due north, which needs no longitude correction.
  return {
    longitude: record.longitude,
    latitude: record.latitude + offsetMeters / 111_195,
  };
}

describe("distanceMeters", () => {
  it("measures a known separation", () => {
    // Dufourspitze to Capanna Margherita is ~1.2 km on the ground.
    const d = distanceMeters(DUFOURSPITZE, CAPANNA_MARGHERITA);
    assert.ok(d > 1100 && d < 1400, `expected ~1.2 km, got ${d}`);
  });

  it("is zero for the same point and symmetric", () => {
    assert.equal(distanceMeters(DUFOURSPITZE, DUFOURSPITZE), 0);
    assert.equal(
      distanceMeters(DUFOURSPITZE, NORDEND),
      distanceMeters(NORDEND, DUFOURSPITZE),
    );
  });
});

describe("resolveSelection", () => {
  const index = [DUFOURSPITZE, NORDEND, CAPANNA_MARGHERITA];

  it("selects the object under an accurate tap", () => {
    const result = resolveSelection(index, tapAt(DUFOURSPITZE), FINE);
    assert.equal(result.status, "selected");
    assert.equal(result.status === "selected" && result.record.id, DUFOURSPITZE.id);
  });

  it("selects an object slightly off-centre, within the tap radius", () => {
    const offset = TAP_RADIUS_PIXELS * FINE * 0.8;
    const result = resolveSelection(index, tapAt(DUFOURSPITZE, offset), FINE);
    assert.equal(result.status, "selected");
    assert.equal(result.status === "selected" && result.record.id, DUFOURSPITZE.id);
  });

  it("selects nothing just outside the tap radius", () => {
    const offset = TAP_RADIUS_PIXELS * FINE * 1.2;
    const result = resolveSelection(index, tapAt(DUFOURSPITZE, offset), FINE);
    assert.equal(result.status, "empty");
  });

  it("selects nothing on open ground", () => {
    const result = resolveSelection(index, { longitude: 7.5, latitude: 45.5 }, FINE);
    assert.equal(result.status, "empty");
  });

  it("refuses to choose between two nearly equidistant objects", () => {
    // Half way between the two summits: neither is the obvious intent.
    const midpoint = {
      longitude: (DUFOURSPITZE.longitude + NORDEND.longitude) / 2,
      latitude: (DUFOURSPITZE.latitude + NORDEND.latitude) / 2,
    };
    // A scale coarse enough that the tap radius reaches both, still inside
    // the floor.
    const scale = 18;
    const result = resolveSelection(index, midpoint, scale);
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.record.id).sort(),
      [DUFOURSPITZE.id, NORDEND.id].sort(),
    );
  });

  it("still resolves when one candidate is clearly nearer than the rival", () => {
    // Nudge the tap onto Dufourspitze; Nordend stays in radius but far behind.
    const result = resolveSelection(index, tapAt(DUFOURSPITZE), 18);
    assert.equal(result.status, "selected");
    assert.equal(result.status === "selected" && result.record.id, DUFOURSPITZE.id);
  });

  it("brackets the ambiguity ratio: just inside is ambiguous, just outside is not", () => {
    // Both records sit due north of the tap, at 10 m and at 10 m x <ratio>.
    const rivalAt = (metres: number): ObjectRecord[] => [
      { ...DUFOURSPITZE, id: "node/1", name: "Near", latitude: tapAt(DUFOURSPITZE, 10).latitude },
      {
        ...DUFOURSPITZE,
        id: "node/2",
        name: "Far",
        latitude: tapAt(DUFOURSPITZE, metres).latitude,
      },
    ];
    const tap = tapAt(DUFOURSPITZE);
    assert.equal(
      resolveSelection(rivalAt(10 * (AMBIGUITY_RATIO - 0.01)), tap, FINE).status,
      "ambiguous",
    );
    assert.equal(
      resolveSelection(rivalAt(10 * (AMBIGUITY_RATIO + 0.01)), tap, FINE).status,
      "selected",
    );
  });

  it("caps how many candidates it offers", () => {
    const crowd = Array.from({ length: 9 }, (_unused, i) => ({
      ...DUFOURSPITZE,
      id: `node/${i + 1}`,
      name: `Summit ${i + 1}`,
      latitude: DUFOURSPITZE.latitude + i / 111_195,
    }));
    const result = resolveSelection(crowd, tapAt(DUFOURSPITZE, 20), FINE);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.status === "ambiguous" && result.candidates.length, 5);
  });

  it("refuses to select at all below the scale floor", () => {
    const coarse = SELECTION_MAX_METERS_PER_PIXEL + 0.1;
    const result = resolveSelection(index, tapAt(DUFOURSPITZE), coarse);
    assert.equal(result.status, "zoom-in");
  });

  it("selects at exactly the scale floor", () => {
    const result = resolveSelection(
      [DUFOURSPITZE],
      tapAt(DUFOURSPITZE),
      SELECTION_MAX_METERS_PER_PIXEL,
    );
    assert.equal(result.status, "selected");
  });

  it("treats a nonsensical scale as unselectable rather than guessing", () => {
    assert.equal(resolveSelection(index, tapAt(DUFOURSPITZE), 0).status, "zoom-in");
    assert.equal(resolveSelection(index, tapAt(DUFOURSPITZE), -1).status, "zoom-in");
    assert.equal(resolveSelection(index, tapAt(DUFOURSPITZE), Number.NaN).status, "zoom-in");
  });

  it("selects nothing from an empty index", () => {
    assert.equal(resolveSelection([], tapAt(DUFOURSPITZE), FINE).status, "empty");
  });

  it("gives the same answer for the same tap regardless of record order", () => {
    const tap = tapAt(DUFOURSPITZE, 5);
    const forward = resolveSelection(index, tap, FINE);
    const reversed = resolveSelection([...index].reverse(), tap, FINE);
    assert.deepEqual(forward, reversed);
  });

  it("does not prefer a hut over a peak, or the reverse - only distance", () => {
    const result = resolveSelection(index, tapAt(CAPANNA_MARGHERITA), FINE);
    assert.equal(result.status, "selected");
    assert.equal(result.status === "selected" && result.record.kind, "hut");
  });
});
