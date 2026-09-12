/**
 * Resolve a tap on the map to an object-index record - the matching problem.
 *
 * ## The rule
 *
 * **Index-first proximity, with an explicit ambiguity result and a scale
 * floor.** A tap gives a geographic point. We take the nearest index record
 * within a tap radius of `TAP_RADIUS_PIXELS` converted to metres at the
 * current map scale. If a second record is nearly as close
 * (`AMBIGUITY_RATIO`), we refuse to choose and hand back the candidates.
 * Below the scale floor (`SELECTION_MAX_METERS_PER_PIXEL`) we select nothing
 * and say so.
 *
 * Nothing here reads MapLibre's rendered features. That is the whole point:
 * `docs/research/maptiler-outdoor-objects.md` measures what those features
 * are on the real Outdoor style - saddles/passes rendered by no layer at all,
 * only `rank == 1` peaks (~25% of the source layer, and `rank` is recomputed
 * per zoom), symbol collision cutting 20 placed peak labels at z12 down to 1
 * at z14, parking icons only from z15, feature ids under two different
 * undocumented encodings, and a served feature whose OSM node is HTTP 410
 * Gone. A rendered feature is neither a complete set of eligible objects nor
 * a durable identity.
 *
 * ## Failure modes, stated rather than hidden
 *
 * 1. **The index is the world.** An object the basemap draws but the index
 *    lacks - anything outside the published shard, or newer than the last
 *    build - is not selectable, and the user sees "no object here" while
 *    looking at a label. That is the honest answer: we have no snow history
 *    for it either. The alternative, selecting *something else* nearby, is the
 *    hazard this rule exists to avoid.
 * 2. **Proximity is not intent.** The nearest record can still be the wrong
 *    one, most plausibly a subsidiary summit next to the main one, or a
 *    parking area next to the hut it serves. `AMBIGUITY_RATIO` catches the
 *    close cases; a genuinely isolated wrong answer (index coordinate placed
 *    at a hut's building centroid rather than its door, say) is not caught.
 * 3. **The scale floor trades reach for safety.** Around 20 m/px the tap
 *    radius is already 440 m; below that, peaks in the Alps are packed several
 *    to a tap and every choice would be a guess, so we make none. The cost is
 *    that the app's own initial view is below the floor and objects are not
 *    selectable until the user zooms in.
 * 4. **Index coordinates are representative points.** For ways and relations
 *    the pipeline normalises geometry to one point, so a large parking area or
 *    a spread-out hamlet is matched from its centre; a tap on its edge can
 *    miss it while a tap on empty ground inside it can hit.
 * 5. **Equirectangular distance.** Accurate to well under a metre at these
 *    radii and latitudes, and wrong across the antimeridian - irrelevant for
 *    the Alps and Apennines, but not a general-purpose geodesic.
 *
 * Pure and dependency-free, so `npm test` runs it directly under Node.
 */
import type { ObjectRecord } from "./objectIndexSchema.ts";

/** Half of a comfortable 44 CSS px touch target (spec section 10). */
export const TAP_RADIUS_PIXELS = 22;

/**
 * Coarsest map scale at which a tap is allowed to select anything.
 *
 * At 20 m/px the tap radius is 440 m; that is already generous in Alpine
 * terrain. Any coarser and a single fingertip covers a whole ridge of named
 * summits, so the honest answer is to ask for more zoom rather than to pick
 * one. Roughly MapLibre zoom 11.4 at 45 degrees north.
 */
export const SELECTION_MAX_METERS_PER_PIXEL = 20;

/**
 * A runner-up this close to the nearest candidate makes the tap ambiguous.
 *
 * 1.5 is a judgement call, not a measurement: it is loose enough that a clear
 * tap on an isolated summit still resolves, and tight enough that two summits
 * on the same ridge both reach the panel instead of one being chosen silently.
 */
export const AMBIGUITY_RATIO = 1.5;

/** Most candidates ever offered for disambiguation. */
export const MAX_CANDIDATES = 5;

export type LngLat = { longitude: number; latitude: number };

export type Candidate = {
  record: ObjectRecord;
  distanceMeters: number;
};

export type Selection =
  /** One clear winner. */
  | { status: "selected"; record: ObjectRecord; distanceMeters: number }
  /** Two or more records too close together to choose between. */
  | { status: "ambiguous"; candidates: Candidate[] }
  /** Nothing in the index within the tap radius. */
  | { status: "empty"; radiusMeters: number }
  /** The map is zoomed too far out for any tap to mean one object. */
  | { status: "zoom-in"; metersPerPixel: number };

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEGREES_TO_METERS = (Math.PI / 180) * EARTH_RADIUS_METERS;

/**
 * Equirectangular distance in metres. Cheap, and accurate far beyond the few
 * hundred metres this module ever compares over.
 */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const meanLatitude = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const dx = (a.longitude - b.longitude) * Math.cos(meanLatitude) * DEGREES_TO_METERS;
  const dy = (a.latitude - b.latitude) * DEGREES_TO_METERS;
  return Math.hypot(dx, dy);
}

/**
 * Resolve a tap against the loaded index.
 *
 * `metersPerPixel` comes from the live map rather than from a zoom-to-scale
 * formula, so this module never has to know whether the renderer counts zoom
 * in 256 px or 512 px tiles.
 *
 * A linear scan is deliberate. A publishable shard is thousands of records,
 * not the 244,011 of the whole Alps+Italy build (worklog 2026-09-11), and one
 * pass costs far less than a tap's own frame budget. Add a spatial index when
 * a measurement says to, not before.
 */
export function resolveSelection(
  objects: readonly ObjectRecord[],
  tap: LngLat,
  metersPerPixel: number,
): Selection {
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    return { status: "zoom-in", metersPerPixel };
  }
  if (metersPerPixel > SELECTION_MAX_METERS_PER_PIXEL) {
    return { status: "zoom-in", metersPerPixel };
  }

  const radiusMeters = TAP_RADIUS_PIXELS * metersPerPixel;
  const within: Candidate[] = [];
  for (const record of objects) {
    const distance = distanceMeters(tap, record);
    if (distance <= radiusMeters) within.push({ record, distanceMeters: distance });
  }
  if (within.length === 0) return { status: "empty", radiusMeters };

  // Ties broken by id so the same tap always gives the same answer, whatever
  // order the shard happened to list its records in.
  within.sort(
    (a, b) =>
      a.distanceMeters - b.distanceMeters || (a.record.id < b.record.id ? -1 : 1),
  );

  const nearest = within[0];
  const rivals = within.filter(
    (candidate) => candidate.distanceMeters <= nearest.distanceMeters * AMBIGUITY_RATIO,
  );
  if (rivals.length > 1) {
    return { status: "ambiguous", candidates: rivals.slice(0, MAX_CANDIDATES) };
  }

  return {
    status: "selected",
    record: nearest.record,
    distanceMeters: nearest.distanceMeters,
  };
}
