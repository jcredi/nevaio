/**
 * Runtime validation for the Geoapify Routing API response, decided as the
 * MVP routing provider on 2026-09-13 (`docs/research/routing-and-dem-options.md`,
 * the 2026-09-13 amendment - which supersedes the Mapbox decision of the day
 * before, after Mapbox began asking for payment details at signup).
 *
 * This is the network-facing trust boundary for routing, in the same spirit as
 * `../objects/objectIndexSchema.ts` and `../snow/manifestSchema.ts`: the types
 * the app would like to receive check nothing at runtime, so this is the actual
 * gate between an HTTP response and the map.
 *
 * **Repo rule (`docs/agent-guide.md`)**: each network-facing validator keeps its
 * own private copies of the primitive-check helpers, deliberately, so each one
 * reads and audits end to end on its own. Do not import them from a sibling and
 * do not extract a shared module.
 *
 * The shape, as documented by Geoapify: a GeoJSON `FeatureCollection` whose
 * first feature carries the route.
 *
 *   { "type": "FeatureCollection",
 *     "features": [ { "type": "Feature",
 *                     "properties": { "distance": 12345,
 *                                     "distance_units": "Meters",
 *                                     "time": 9876, ... },
 *                     "geometry": { "type": "MultiLineString",
 *                                   "coordinates": [ [ [lon, lat], ... ] ] } } ] }
 *
 * Three differences from the Mapbox shape this replaced, each of which is a way
 * to get a wrong answer rather than an error, and so each of which is checked:
 *
 *  - **The geometry is a `MultiLineString`, one line per leg**, not a single
 *    `LineString`. This app only ever sends two waypoints (spec section 8.1:
 *    one origin, one destination), so there is normally exactly one line - but
 *    the lines are validated and concatenated in order regardless, with a
 *    repeated joint vertex between consecutive legs dropped, so a multi-leg
 *    reply can never silently lose its tail. A plain `LineString` is accepted
 *    too, for the same reason.
 *  - **`distance_units` is a field, not an assumption.** Geoapify can answer in
 *    `"Miles"`. A miles figure read as metres would understate a route by a
 *    factor of 1,600 and be entirely plausible on screen, so a unit this app
 *    did not ask for is rejected outright rather than converted - converting
 *    would hide a request we did not mean to make.
 *  - **There is no in-band `code` field.** Mapbox reported "no route" with HTTP
 *    200 and `code: "NoRoute"`; Geoapify reports failures with HTTP status
 *    codes, which `directions.ts` maps. What this module owns is the other
 *    no-route signal: a well-formed `FeatureCollection` with an **empty
 *    `features` array**, which is a real answer ("nothing connects these
 *    points"), not a malformed body - hence `NoRouteError`, thrown separately.
 *
 * Elevation: this validator ignores a third entry in a GeoJSON position rather
 * than rejecting it, and never carries it through. Geoapify *can* return real
 * per-point elevation, but only when the request asks for `details=elevation`,
 * and this app does not ask yet (`docs/plan.md` item 2: the provider swap lands
 * before the profile is built on an unnamed DEM). Until a deliberate decision
 * is made to consume it, a stray third number must not be mistaken for one.
 *
 * This module imports nothing (no map config, no `import.meta.env`, no `fetch`,
 * no DOM, no MapLibre), so `npm test` runs it directly under Node.
 */

/** One validated route, normalised for downstream map/profile use. */
export type ValidatedRoute = {
  distanceMeters: number;
  /**
   * The provider's own travel-time estimate, in seconds. Carried because it is
   * in the response, and deliberately **not shown** - see `routePanel.ts` for
   * why a flat-ground pedestrian estimate is worse than no number at all on
   * alpine terrain.
   */
  durationSeconds: number;
  /** Always two-element [lon, lat] tuples; see the module docstring on elevation. */
  coordinates: [number, number][];
};

/**
 * A realistic long alpine day route - 40 km at one vertex every 5 m of path -
 * is about 8,000 points. 200,000 gives roughly 25x that headroom for a
 * multi-day traverse or a wandering path, while still being small enough that
 * holding and rendering it can never be the thing that exhausts memory: a
 * hostile or broken response cannot hand the app a multi-million-point line.
 */
export const MAX_ROUTE_COORDINATES = 200_000;

/** The only unit this app asks for, and therefore the only one it will read. */
const EXPECTED_DISTANCE_UNITS = "meters";

export type RoutePoint = { longitude: number; latitude: number };

/**
 * One waypoint in Geoapify's `waypoints` request parameter.
 *
 * **The order is `lat,lon`** - the reverse of GeoJSON's `[lon, lat]`, which is
 * what the rest of this feature speaks and what this same API returns in its
 * own geometry. Getting it backwards does not error: `45.93,7.86` and
 * `7.86,45.93` are both valid points on Earth, so the app would draw a
 * confident route through the Indian Ocean. That is why this is a named,
 * tested function rather than string interpolation at the call site, and why
 * it lives here in the pure module - `directions.ts` imports config and so
 * cannot be reached by `npm test`.
 *
 * Six decimals is ~0.1 m, far finer than any path geometry, and keeps the URL
 * short.
 */
export function formatWaypoint(point: RoutePoint): string {
  return `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
}

/** Malformed response: the body is not shaped like a routing response. */
export class DirectionsError extends Error {}

/**
 * A well-formed response reporting that no walking route exists between the
 * requested points. A real answer from the provider, not a parse failure, and
 * deliberately **not** a subclass of `DirectionsError` so that
 * `catch (e) { if (e instanceof NoRouteError) ... }` never has to also rule out
 * a malformed body.
 */
export class NoRouteError extends Error {
  constructor(reason = "the provider returned no route between these points") {
    super(`No walking route: ${reason}`);
  }
}

function fail(message: string): never {
  throw new DirectionsError(message);
}

function requireFiniteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  if (value < min || value > max) fail(`${field} must be between ${min} and ${max}`);
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * One `[lon, lat]` or `[lon, lat, elevation]` GeoJSON position. A third entry
 * is checked for sanity if present and then discarded - see the module
 * docstring's elevation note.
 */
function requirePosition(value: unknown, field: string): [number, number] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    fail(`${field} must be an array of 2 or 3 numbers`);
  }
  const lon = requireFiniteNumber(value[0], `${field}[0]`, -180, 180);
  const lat = requireFiniteNumber(value[1], `${field}[1]`, -90, 90);
  if (value.length === 3) requireFiniteNumber(value[2], `${field}[2]`, -12000, 12000);
  return [lon, lat];
}

function requireLine(value: unknown, field: string): [number, number][] {
  if (!Array.isArray(value)) fail(`${field} must be an array of positions`);
  if (value.length < 2) fail(`${field} must have at least 2 positions`);
  return value.map((position: unknown, index: number) =>
    requirePosition(position, `${field}[${index}]`),
  );
}

/**
 * Flatten the route geometry to one continuous coordinate list.
 *
 * `MultiLineString` is the documented shape, one line per leg; `LineString` is
 * accepted as well. Consecutive legs share their joint vertex, so a repeated
 * point at a seam is dropped - without that, the polyline would carry a
 * zero-length segment at every leg boundary, which `routeProfile.ts` handles
 * safely but which would still be a lie about the geometry.
 */
function requireGeometry(value: unknown, field: string): [number, number][] {
  const geometry = requireObject(value, field);

  if (geometry.type === "LineString") {
    const line = requireLine(geometry.coordinates, `${field}.coordinates`);
    if (line.length > MAX_ROUTE_COORDINATES) {
      fail(`${field} has ${line.length} positions, over the ${MAX_ROUTE_COORDINATES} limit`);
    }
    return line;
  }

  if (geometry.type !== "MultiLineString") {
    fail(`${field}.type must be "MultiLineString" or "LineString", got ${String(geometry.type)}`);
  }
  if (!Array.isArray(geometry.coordinates)) fail(`${field}.coordinates must be an array`);
  if (geometry.coordinates.length === 0) fail(`${field}.coordinates must have at least one line`);

  const combined: [number, number][] = [];
  for (const [index, rawLine] of geometry.coordinates.entries()) {
    const line = requireLine(rawLine, `${field}.coordinates[${index}]`);
    const previous = combined[combined.length - 1];
    const start = previous && previous[0] === line[0][0] && previous[1] === line[0][1] ? 1 : 0;
    for (let i = start; i < line.length; i += 1) combined.push(line[i]);
    // Checked inside the loop, not after it: the point of the cap is to stop a
    // hostile response before it has been fully materialised.
    if (combined.length > MAX_ROUTE_COORDINATES) {
      fail(`${field} exceeds the ${MAX_ROUTE_COORDINATES} position limit`);
    }
  }
  if (combined.length < 2) fail(`${field} must describe at least 2 distinct positions`);
  return combined;
}

/**
 * Validate a Geoapify Routing API response for the `hike` mode.
 *
 * Throws `NoRouteError` when the body is well formed but carries no route, and
 * `DirectionsError` when the body is not shaped like a routing response at all.
 * Only the first feature is read: spec section 8.1 limits the MVP to one
 * origin, one destination and one mode, with no alternatives UI, so accepting
 * more would be inventing scope this app has nowhere to put.
 */
export function validateDirectionsResponse(document: unknown): ValidatedRoute {
  const source = requireObject(document, "routing response");

  if (source.type !== "FeatureCollection") {
    fail(`type must be "FeatureCollection", got ${String(source.type)}`);
  }
  if (!Array.isArray(source.features)) fail("features must be an array");
  // Well formed, and an answer: there is no route between these points.
  if (source.features.length === 0) throw new NoRouteError();

  const feature = requireObject(source.features[0], "features[0]");
  const properties = requireObject(feature.properties, "features[0].properties");

  const units = properties.distance_units;
  if (typeof units !== "string" || units.toLowerCase() !== EXPECTED_DISTANCE_UNITS) {
    // Never converted - see the module docstring. A unit we did not ask for
    // means the request was not the one we think we made.
    fail(`features[0].properties.distance_units must be "Meters", got ${String(units)}`);
  }

  const distanceMeters = requireFiniteNumber(
    properties.distance,
    "features[0].properties.distance",
    0,
    Infinity,
  );
  const durationSeconds = requireFiniteNumber(
    properties.time,
    "features[0].properties.time",
    0,
    Infinity,
  );
  const coordinates = requireGeometry(feature.geometry, "features[0].geometry");

  return { distanceMeters, durationSeconds, coordinates };
}
