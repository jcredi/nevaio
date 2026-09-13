/**
 * Resolve a tap on the map to an object-index record - the matching problem.
 *
 * ## The rule
 *
 * **Index-first proximity, with an explicit ambiguity result and a scale
 * floor.** A tap gives a geographic point. We take the nearest index record
 * within a tap radius of `TAP_RADIUS_PIXELS` converted to metres at the
 * current map scale. If a second record is within `AMBIGUITY_PIXELS` of it on
 * screen, we refuse to choose and hand back the candidates.
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
 *    parking area next to the hut it serves. `AMBIGUITY_PIXELS` catches the
 *    close cases; a genuinely isolated wrong answer (index coordinate placed
 *    at a hut's building centroid rather than its door, say) is not caught.
 * 3. **The scale floor trades reach for safety**, and was retuned on
 *    2026-09-13. It now sits at 80 m/px (~zoom 9.4) rather than 20 (~11.4),
 *    because requiring that much zoom to select anything was the app's most
 *    complained-about behaviour. Safety is preserved by answering with a
 *    *list* instead of a guess: `AMBIGUITY_PIXELS` makes ambiguity a
 *    screen-space question, so a coarse tap hands back the several summits
 *    under the finger rather than choosing one of them.
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
 * **Raised from 20 to 80 m/px on 2026-09-13**, on the owner's report that
 * selecting a landmark "requires zooming on the map a LOT". 20 m/px is roughly
 * MapLibre zoom 11.4 at 45 degrees north; 80 is roughly zoom 9.4, so a whole
 * valley is selectable where before you had to close in on one cirque.
 *
 * The original floor existed for a real reason - at a coarse scale one
 * fingertip covers a ridge of named summits, and picking one of them silently
 * is a guess presented as an answer. That reason has not gone away; what
 * changed is the response to it. Ambiguity is now measured in *screen*
 * distance (`AMBIGUITY_PIXELS`), so a coarse tap returns the candidates it
 * genuinely cannot distinguish and the panel offers them as a list. Refusing
 * to answer is the right behaviour only when there is nothing useful to say -
 * and "here are the five summits under your finger" is useful.
 *
 * A floor is still needed, because the tap radius grows with the scale and at
 * some point "nearest" stops meaning anything: at 80 m/px the radius is
 * already 1.8 km. It also bounds shard loading - `shardsAreWorthLoading` in
 * `main.ts` shares this constant, and at this scale a desktop viewport spans
 * at most a few MGRS shards.
 */
export const SELECTION_MAX_METERS_PER_PIXEL = 80;

/**
 * A runner-up within this many screen pixels of the nearest is also ambiguous.
 *
 * **This replaced a scale-free `AMBIGUITY_RATIO` of 1.5 on 2026-09-13**, when
 * the selection floor was raised and the ratio turned out to be the wrong shape
 * for the question. At a coarse scale the nearest candidate can be 400 m away
 * with six more inside the next 200 m; 1.5x on 400 m keeps only some of them,
 * so the tap resolves to one summit out of a cluster no fingertip could have
 * distinguished. What actually decides whether two objects were
 * distinguishable is how far apart they were *on screen*, so that is what this
 * measures.
 *
 * The ratio was not kept alongside it as a second rule. It could never fire:
 * the nearest candidate is by definition within `TAP_RADIUS_PIXELS` (22), so
 * `nearest x 1.5` never exceeds `nearest + 12 px` in any reachable case, and a
 * constant that cannot change an outcome is worse than no constant - it reads
 * like a safeguard while doing nothing.
 *
 * 12 px against a 22 px radius: tap squarely on an isolated summit and it still
 * resolves, because a rival must then be inside 12 px to compete. Tap loosely
 * between two and both come back.
 */
export const AMBIGUITY_PIXELS = 12;

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
  // Screen distance, not a ratio - see `AMBIGUITY_PIXELS`. This is what lets a
  // coarse tap hand back the cluster it could not distinguish instead of
  // picking one member of it.
  const margin = nearest.distanceMeters + AMBIGUITY_PIXELS * metersPerPixel;
  const rivals = within.filter((candidate) => candidate.distanceMeters <= margin);
  if (rivals.length > 1) {
    return { status: "ambiguous", candidates: rivals.slice(0, MAX_CANDIDATES) };
  }

  return {
    status: "selected",
    record: nearest.record,
    distanceMeters: nearest.distanceMeters,
  };
}
