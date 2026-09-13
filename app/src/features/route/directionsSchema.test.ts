/**
 * Tests for the Geoapify Routing API validator (spec section 8).
 *
 * The cases that matter are the ones where a wrong answer is plausible rather
 * than obviously broken: a miles distance read as metres, a multi-leg geometry
 * whose tail is silently dropped, an empty feature list treated as a parse
 * failure instead of the real answer it is.
 *
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DirectionsError,
  MAX_ROUTE_COORDINATES,
  MAX_ROUTE_SPAN_METERS,
  NoRouteError,
  RouteTooLongError,
  formatWaypoint,
  routeSpanMeters,
  validateDirectionsResponse,
} from "./directionsSchema.ts";

/** A minimal well-formed response, overridable per case. */
function response(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { distance: 4820, distance_units: "Meters", time: 5400 },
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [7.86, 45.93],
              [7.87, 45.94],
              [7.88, 45.95],
            ],
          ],
        },
      },
    ],
    ...overrides,
  };
}

describe("validateDirectionsResponse", () => {
  it("accepts a well-formed hike route", () => {
    const route = validateDirectionsResponse(response());
    assert.equal(route.distanceMeters, 4820);
    assert.equal(route.durationSeconds, 5400);
    assert.deepEqual(route.coordinates, [
      [7.86, 45.93],
      [7.87, 45.94],
      [7.88, 45.95],
    ]);
  });

  it("treats an empty feature list as no route, not a malformed body", () => {
    assert.throws(() => validateDirectionsResponse(response({ features: [] })), NoRouteError);
    // The two must stay distinguishable: a caller catching NoRouteError to show
    // "no path is mapped here" must never swallow a parse failure as well.
    assert.doesNotThrow(() => {
      try {
        validateDirectionsResponse(response({ features: [] }));
      } catch (error) {
        assert.ok(!(error instanceof DirectionsError));
      }
    });
  });

  it("concatenates a multi-leg geometry and drops the repeated joint vertex", () => {
    const route = validateDirectionsResponse(
      response({
        features: [
          {
            type: "Feature",
            properties: { distance: 10, distance_units: "Meters", time: 10 },
            geometry: {
              type: "MultiLineString",
              coordinates: [
                [
                  [7.0, 45.0],
                  [7.1, 45.1],
                ],
                // Starts on the previous leg's last point - the seam.
                [
                  [7.1, 45.1],
                  [7.2, 45.2],
                ],
              ],
            },
          },
        ],
      }),
    );
    assert.deepEqual(route.coordinates, [
      [7.0, 45.0],
      [7.1, 45.1],
      [7.2, 45.2],
    ]);
  });

  it("accepts a plain LineString geometry too", () => {
    const route = validateDirectionsResponse(
      response({
        features: [
          {
            type: "Feature",
            properties: { distance: 10, distance_units: "Meters", time: 10 },
            geometry: {
              type: "LineString",
              coordinates: [
                [7.0, 45.0],
                [7.1, 45.1],
              ],
            },
          },
        ],
      }),
    );
    assert.equal(route.coordinates.length, 2);
  });

  it("refuses a distance in miles rather than converting it", () => {
    // The whole point: 3 miles read as 3 metres is absurd, but 3 miles read as
    // "3" on a panel that says metres is entirely plausible and wrong.
    assert.throws(
      () =>
        validateDirectionsResponse(
          response({
            features: [
              {
                type: "Feature",
                properties: { distance: 3, distance_units: "Miles", time: 10 },
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [7, 45],
                    [7.1, 45.1],
                  ],
                },
              },
            ],
          }),
        ),
      DirectionsError,
    );
  });

  it("accepts the unit case-insensitively", () => {
    const route = validateDirectionsResponse(
      response({
        features: [
          {
            type: "Feature",
            properties: { distance: 100, distance_units: "meters", time: 10 },
            geometry: {
              type: "LineString",
              coordinates: [
                [7, 45],
                [7.1, 45.1],
              ],
            },
          },
        ],
      }),
    );
    assert.equal(route.distanceMeters, 100);
  });

  it("ignores a third (elevation) entry in a position without carrying it through", () => {
    const route = validateDirectionsResponse(
      response({
        features: [
          {
            type: "Feature",
            properties: { distance: 100, distance_units: "Meters", time: 10 },
            geometry: {
              type: "LineString",
              coordinates: [
                [7, 45, 3200],
                [7.1, 45.1, 3600],
              ],
            },
          },
        ],
      }),
    );
    assert.deepEqual(route.coordinates, [
      [7, 45],
      [7.1, 45.1],
    ]);
  });

  it("refuses a body that is not a FeatureCollection", () => {
    assert.throws(() => validateDirectionsResponse(response({ type: "Feature" })), DirectionsError);
    assert.throws(() => validateDirectionsResponse(null), DirectionsError);
    assert.throws(() => validateDirectionsResponse([]), DirectionsError);
  });

  it("refuses a geometry with fewer than two positions", () => {
    assert.throws(
      () =>
        validateDirectionsResponse(
          response({
            features: [
              {
                type: "Feature",
                properties: { distance: 1, distance_units: "Meters", time: 1 },
                geometry: { type: "LineString", coordinates: [[7, 45]] },
              },
            ],
          }),
        ),
      DirectionsError,
    );
  });

  it("refuses out-of-range and non-finite coordinates", () => {
    for (const bad of [
      [181, 45],
      [7, 91],
      [Number.NaN, 45],
      [7, Number.POSITIVE_INFINITY],
    ]) {
      assert.throws(
        () =>
          validateDirectionsResponse(
            response({
              features: [
                {
                  type: "Feature",
                  properties: { distance: 1, distance_units: "Meters", time: 1 },
                  geometry: { type: "LineString", coordinates: [[7, 45], bad] },
                },
              ],
            }),
          ),
        DirectionsError,
        `expected ${JSON.stringify(bad)} to be refused`,
      );
    }
  });

  it("refuses a missing or non-numeric distance or time", () => {
    for (const properties of [
      { distance_units: "Meters", time: 10 },
      { distance: "far", distance_units: "Meters", time: 10 },
      { distance: 10, distance_units: "Meters" },
      { distance: 10, distance_units: "Meters", time: -1 },
    ]) {
      assert.throws(
        () =>
          validateDirectionsResponse(
            response({
              features: [
                {
                  type: "Feature",
                  properties,
                  geometry: {
                    type: "LineString",
                    coordinates: [
                      [7, 45],
                      [7.1, 45.1],
                    ],
                  },
                },
              ],
            }),
          ),
        DirectionsError,
        `expected ${JSON.stringify(properties)} to be refused`,
      );
    }
  });

  it("bounds the number of positions", () => {
    const tooMany = Array.from({ length: MAX_ROUTE_COORDINATES + 2 }, (_, i) => [
      7 + i * 1e-7,
      45,
    ]);
    assert.throws(
      () =>
        validateDirectionsResponse(
          response({
            features: [
              {
                type: "Feature",
                properties: { distance: 1, distance_units: "Meters", time: 1 },
                geometry: { type: "LineString", coordinates: tooMany },
              },
            ],
          }),
        ),
      DirectionsError,
    );
  });
});

describe("formatWaypoint", () => {
  it("emits lat,lon - the reverse of the GeoJSON order the same API returns", () => {
    // Dufourspitze. If this ever emits "7.866757,45.936924" the app will route
    // through the Indian Ocean without erroring, which is the whole reason
    // this has a test.
    assert.equal(
      formatWaypoint({ longitude: 7.866757, latitude: 45.936924 }),
      "45.936924,7.866757",
    );
  });

  it("keeps six decimals, padding and truncating as needed", () => {
    assert.equal(formatWaypoint({ longitude: 7, latitude: 45 }), "45.000000,7.000000");
    assert.equal(
      formatWaypoint({ longitude: 7.1234567, latitude: -45.7654321 }),
      "-45.765432,7.123457",
    );
  });
});

/**
 * The provider's 100 km cap, measured against the live API on 2026-09-13. It
 * reports a breach as a plain HTTP 400, which is why this is checked before
 * the request rather than inferred from the response: an earlier version
 * mapped every 400 to "no walking route connects these points", which would
 * have told someone planning a long traverse that no path existed.
 */
describe("routeSpanMeters and the provider's distance cap", () => {
  it("passes a normal alpine day route", () => {
    // Zermatt to Riffelberg - the pair smoke-tested against the live API.
    const span = routeSpanMeters(
      { longitude: 7.7492, latitude: 46.0207 },
      { longitude: 7.7576, latitude: 45.995 },
    );
    assert.ok(span < MAX_ROUTE_SPAN_METERS, `expected ${span} m to be under the cap`);
    assert.ok(span > 2500 && span < 3500, `expected ~2.9 km, got ${span} m`);
  });

  it("catches the span the provider itself refused", () => {
    // The request that produced the measured 400: the provider called it
    // "Estimated distance is 575781 meter(s)", so our own measure must agree
    // closely or the pre-check would not mirror theirs.
    const span = routeSpanMeters(
      { longitude: 6, latitude: 41 },
      { longitude: 7.7492, latitude: 46.0207 },
    );
    assert.ok(span > MAX_ROUTE_SPAN_METERS);
    assert.ok(
      Math.abs(span - 575781) < 5000,
      `expected to agree with the provider's 575781 m estimate, got ${Math.round(span)} m`,
    );
  });

  it("builds a RouteTooLongError that reads as a sentence and is catchable as a DirectionsError", () => {
    const error = new RouteTooLongError(575781);
    assert.match(error.message, /576 km apart in a straight line/);
    assert.match(error.message, /at most 100 km/);
    // The panel renders a DirectionsError's message to the user; this must
    // ride that path rather than the no-route path.
    assert.ok(error instanceof DirectionsError);
    assert.ok(!(error instanceof NoRouteError));
  });
});

/**
 * Shapes taken verbatim from the live API on 2026-09-13. These are the cases a
 * hand-written fixture would have got wrong.
 */
describe("shapes measured against the live Geoapify API", () => {
  it("accepts the lowercase distance_units the API actually sends", () => {
    // The docs say "Meters"; the API sends "meters". The case-insensitive
    // comparison is load-bearing, not defensive.
    const route = validateDirectionsResponse(
      response({
        features: [
          {
            type: "Feature",
            properties: { distance: 7784, distance_units: "meters", time: 12269.39 },
            geometry: {
              type: "MultiLineString",
              coordinates: [
                [
                  [7.749141, 46.020686],
                  [7.75, 46.019],
                ],
              ],
            },
          },
        ],
      }),
    );
    assert.equal(route.distanceMeters, 7784);
  });

  it("accepts the degenerate zero-length route the API returns for one point twice", () => {
    // Measured: HTTP 200, distance 0, a two-point line with identical
    // coordinates. A real answer, not a malformed one.
    const route = validateDirectionsResponse(
      response({
        features: [
          {
            type: "Feature",
            properties: { distance: 0, distance_units: "meters", time: 0 },
            geometry: {
              type: "MultiLineString",
              coordinates: [
                [
                  [7.749141, 46.020686],
                  [7.749141, 46.020686],
                ],
              ],
            },
          },
        ],
      }),
    );
    assert.equal(route.distanceMeters, 0);
    assert.equal(route.coordinates.length, 2);
  });
});
