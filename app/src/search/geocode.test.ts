/**
 * Tests for the MapTiler geocoding adapter (audit F11, spec amendment v1.9).
 *
 * The fixtures below are trimmed from real API responses, so the OSM-tag
 * classification is checked against what the service actually returns rather
 * than what the docs imply. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGeocodeResponse, toGeocodeResult } from "./geocodeResult.ts";

/** Ortler/Ortles, as returned for the query "Ortler" with types=poi,place. */
const PEAK = {
  type: "Feature",
  properties: {
    ref: "osm:n26864153",
    country_code: "it",
    feature_tags: {
      natural: "peak",
      "summit:cross": "yes",
      ele: "3905",
      prominence: "1953",
    },
    categories: ["peak"],
  },
  geometry: { type: "Point", coordinates: [10.544930398464203, 46.50909573937111] },
  bbox: [10.544930398464203, 46.50909573937111, 10.544930398464203, 46.50909573937111],
  center: [10.544930398464203, 46.50909573937111],
  place_name: "Ortler - Ortles, Stilfs - Stelvio, Italy",
  place_type: ["poi"],
  text: "Ortler - Ortles",
};

/** Payerhütte, whose tags put "building" alongside the hut classification. */
const HUT = {
  properties: {
    feature_tags: { tourism: "alpine_hut", building: "yes", phone: "+39 0473 613010" },
    categories: ["alpine hut", "building"],
  },
  center: [10.5605, 46.5108],
  place_name: "Payerhütte - Rifugio Payer, Stilfs - Stelvio, Italy",
  place_type: ["poi"],
  text: "Payerhütte - Rifugio Payer",
};

/** An administrative result: no OSM tags, so it falls back to place vocabulary. */
const MUNICIPALITY = {
  properties: { kind: "admin_area", place_designation: "town" },
  bbox: [11.25, 46.42, 11.42, 46.54],
  center: [11.3548, 46.4983],
  place_name: "Bolzano, South Tyrol, Italy",
  place_type: ["municipality"],
  text: "Bolzano",
};

describe("toGeocodeResult", () => {
  it("classifies a peak from its OSM tags", () => {
    const result = toGeocodeResult(PEAK);

    assert.ok(result);
    assert.equal(result.category, "natural");
    assert.equal(result.type, "peak");
    assert.equal(result.displayName, "Ortler - Ortles, Stilfs - Stelvio, Italy");
    assert.equal(result.lat, 46.50909573937111);
    assert.equal(result.lon, 10.544930398464203);
  });

  it("prefers the meaningful tag over a bare yes-valued one", () => {
    // building=yes must not win over tourism=alpine_hut, or huts lose their icon.
    const result = toGeocodeResult(HUT);

    assert.ok(result);
    assert.equal(result.category, "tourism");
    assert.equal(result.type, "alpine_hut");
  });

  it("falls back to place vocabulary for administrative results", () => {
    const result = toGeocodeResult(MUNICIPALITY);

    assert.ok(result);
    assert.equal(result.category, "place");
    assert.equal(result.type, "town");
    assert.deepEqual(result.bounds, { west: 11.25, south: 46.42, east: 11.42, north: 46.54 });
  });

  it("uses a degenerate bbox for a point feature", () => {
    const result = toGeocodeResult(PEAK);

    assert.ok(result);
    assert.equal(result.bounds.west, result.bounds.east);
    assert.equal(result.bounds.south, result.bounds.north);
  });

  it("substitutes a degenerate bbox when the response omits or breaks it", () => {
    for (const bbox of [undefined, [1, 2, 3], [10, 46, "x", 47], [10, 46, 5, 47]]) {
      const result = toGeocodeResult({ ...HUT, bbox });

      assert.ok(result, `expected a result for bbox ${JSON.stringify(bbox)}`);
      assert.deepEqual(result.bounds, {
        west: 10.5605,
        south: 46.5108,
        east: 10.5605,
        north: 46.5108,
      });
    }
  });

  it("rejects a feature whose centre cannot move the map", () => {
    // These are the values that would otherwise reach map.flyTo().
    for (const center of [
      undefined,
      [],
      [10.5],
      ["10.5", "46.5"],
      [Number.NaN, 46.5],
      [Number.POSITIVE_INFINITY, 46.5],
      [10.5, 91],
      [181, 46.5],
    ]) {
      assert.equal(toGeocodeResult({ ...HUT, center }), null, JSON.stringify(center));
    }
  });

  it("rejects a feature with no usable label, and falls back to text", () => {
    assert.equal(toGeocodeResult({ ...HUT, place_name: undefined, text: undefined }), null);

    const fromText = toGeocodeResult({ ...HUT, place_name: undefined });
    assert.ok(fromText);
    assert.equal(fromText.displayName, "Payerhütte - Rifugio Payer");
  });

  it("bounds a hostile display name", () => {
    const result = toGeocodeResult({ ...HUT, place_name: "x".repeat(5000) });

    assert.ok(result);
    assert.equal(result.displayName.length, 300);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "Ortler", 42, []]) {
      assert.equal(toGeocodeResult(value), null);
    }
  });
});

describe("parseGeocodeResponse", () => {
  it("keeps usable features and drops broken ones", () => {
    const results = parseGeocodeResponse({
      type: "FeatureCollection",
      features: [PEAK, { ...HUT, center: [Number.NaN, 1] }, MUNICIPALITY],
    });

    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((result) => result.type),
      ["peak", "town"],
    );
  });

  it("caps the number of results regardless of what the service sends", () => {
    const results = parseGeocodeResponse({ features: Array.from({ length: 50 }, () => PEAK) });

    assert.equal(results.length, 6);
  });

  it("returns nothing for a malformed body", () => {
    for (const body of [null, undefined, "nope", 7, { features: "nope" }, {}]) {
      assert.deepEqual(parseGeocodeResponse(body), []);
    }
  });
});
