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
 * **Elevation** arrives per leg, in `legs[].elevation_range`: an array of
 * `[distanceAlongLeg, heightMetres]` pairs. Two things about that shape are
 * easy to get wrong and are handled here:
 *
 *  - **Each leg's distances restart at zero.** Concatenating legs without
 *    offsetting by the preceding legs' lengths would fold a multi-leg profile
 *    back over itself - a chart that looks plausible and is nonsense. Offsets
 *    are applied even though this app sends only two waypoints today.
 *  - **The profile is measured, and measured DEMs have limits.** Verified
 *    2026-09-13 against 200 indexed objects and 8 real routes (the MEASURED
 *    section of `docs/research/routing-and-dem-options.md`): accurate to about
 *    a metre on path-level terrain, but a median 49 m *low* on summits above
 *    3,000 m. Consumers must never read a summit height off this - the object
 *    index's OSM `ele` is what the panel shows - and must resample before
 *    computing ascent, since ~14 m spacing against a ~30 m DEM is oversampled.
 *
 * A third entry inside a GeoJSON *position* is a different thing and is still
 * ignored: the geometry's optional z is not the profile, and conflating them
 * would mix a checked source with an unchecked one.
 *
 * This module imports nothing but the pure geometry helper it shares with the
 * rest of the feature (no map config, no `import.meta.env`, no `fetch`, no DOM,
 * no MapLibre), so `npm test` runs it directly under Node.
 */
import { haversineMeters } from "./routeProfile.ts";

/** One point on the route's elevation profile (spec sections 8.3-8.5). */
export type ElevationPoint = {
  /** Metres from the route start, along the route. */
  distanceMeters: number;
  elevationMeters: number;
};

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
  /**
   * The elevation profile, or `null` when the provider did not return one.
   * Null is a first-class state, not a failure: the route is still perfectly
   * usable without a profile, and inventing flat ground would be worse than
   * saying nothing - so this never falls back to zeros.
   */
  elevationProfile: ElevationPoint[] | null;
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

/**
 * Geoapify refuses a regular routing request whose **estimated** (straight-line)
 * distance exceeds this, with an HTTP 400 and a message naming the limit. From
 * their own error body, measured 2026-09-13:
 *
 *   "Too long distance between locations. Distance should not exceed 100000
 *    meters for a regular API call... Estimated distance is 575781 meter(s)."
 *
 * Checked here, before the request, for two reasons. It spends no credit on a
 * call that cannot succeed; and more importantly it lets the app say something
 * true. An HTTP 400 is indistinguishable from other bad requests without
 * string-matching the provider's prose, and the first version of this client
 * mapped every 400 to "no walking route connects these points" - which would
 * have told a user planning Zermatt to Chamonix that no path exists between
 * them, when the truth is that the request was too long to ask in one go.
 */
export const MAX_ROUTE_SPAN_METERS = 100_000;

/**
 * How far apart two endpoints are in a straight line, by the same measure the
 * provider's own pre-check uses (its "estimated distance" tracks great-circle,
 * not route length - the 575 km figure above is the straight-line distance for
 * that request). Compare against `MAX_ROUTE_SPAN_METERS`.
 */
export function routeSpanMeters(start: RoutePoint, destination: RoutePoint): number {
  return haversineMeters(start, destination);
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
/**
 * The two endpoints are further apart than the provider will route in one
 * request. A subclass of `DirectionsError` on purpose: the panel already
 * renders a `DirectionsError`'s message as a sentence to the user, and this
 * message - unlike a parse failure's - is written to be read by one.
 */
export class RouteTooLongError extends DirectionsError {
  constructor(spanMeters: number) {
    super(
      `these points are ${Math.round(spanMeters / 1000)} km apart in a straight line, ` +
        `and the routing provider handles at most ${MAX_ROUTE_SPAN_METERS / 1000} km per route`,
    );
  }
}

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

/** Bound the profile the way the geometry is bounded - same reasoning. */
const MAX_PROFILE_POINTS = MAX_ROUTE_COORDINATES;

/**
 * The elevation profile across all legs, with each leg's distances offset by
 * the total length of the legs before it, or `null` when the response carries
 * no usable profile.
 *
 * Returns null rather than throwing when the field is simply absent: a route
 * without `details=elevation`, or a provider that declined to supply one, is a
 * valid response. A field that is *present but malformed* does throw - that is
 * a contract violation, not an absence.
 */
function readElevationProfile(legs: unknown, field: string): ElevationPoint[] | null {
  if (!Array.isArray(legs)) return null;

  const profile: ElevationPoint[] = [];
  let offset = 0;
  for (const [index, rawLeg] of legs.entries()) {
    if (typeof rawLeg !== "object" || rawLeg === null) continue;
    const leg = rawLeg as Record<string, unknown>;
    const range = leg.elevation_range;
    if (range === undefined) continue;
    if (!Array.isArray(range)) fail(`${field}[${index}].elevation_range must be an array`);

    let lastDistance = 0;
    for (const entry of range) {
      if (!Array.isArray(entry) || entry.length < 2) {
        fail(`${field}[${index}].elevation_range entries must be [distance, height] pairs`);
      }
      const along = requireFiniteNumber(entry[0], `${field}[${index}].elevation_range distance`, 0, Infinity);
      // Earth's land surface, generously bounded: the Dead Sea shore is about
      // -430 m and Everest 8,849 m. A value outside this is not a height.
      const height = requireFiniteNumber(entry[1], `${field}[${index}].elevation_range height`, -500, 9000);
      profile.push({ distanceMeters: offset + along, elevationMeters: height });
      lastDistance = Math.max(lastDistance, along);
      if (profile.length > MAX_PROFILE_POINTS) {
        fail(`${field} elevation profile exceeds the ${MAX_PROFILE_POINTS} point limit`);
      }
    }
    // Prefer the leg's own declared length for the offset; fall back to the
    // furthest profile distance seen, so a leg missing `distance` still cannot
    // make the next leg restart at zero.
    const declared = typeof leg.distance === "number" && Number.isFinite(leg.distance) ? leg.distance : lastDistance;
    offset += Math.max(declared, lastDistance);
  }

  // A single point is not a profile - it cannot be drawn and its ascent is
  // undefined. Report the honest absence instead.
  return profile.length >= 2 ? profile : null;
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
  const elevationProfile = readElevationProfile(properties.legs, "features[0].properties.legs");

  return { distanceMeters, durationSeconds, coordinates, elevationProfile };
}
