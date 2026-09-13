/**
 * Pure statistics for the route elevation profile (spec section 8.3's
 * "elevation gain/loss where available or derivable", and the data behind
 * section 8.4's profile). No DOM, no fetch, no config - the same posture
 * `routeProfile.ts` and `../objects/seriesChartLayout.ts` take, so `npm test`
 * runs it directly under Node.
 *
 * **Everything here exists because cumulative ascent is the one number a
 * measured DEM can get badly wrong.** Net gain is robust - it is two
 * elevations subtracted, and errors cancel. Ascent is not: it sums every
 * upward step along the route, so DEM noise accumulates into it and never
 * cancels, and sampling a profile more finely inflates it without adding any
 * information. A route that climbs 400 m can be made to report 600 m simply by
 * reading it at a finer spacing. That is not a rounding difference; it is the
 * difference between a hiker's day being feasible or not.
 *
 * Two defences, both measured rather than assumed on 2026-09-13 (see the
 * MEASURED section of `docs/research/routing-and-dem-options.md`):
 *
 *  - **Resample before summing.** The provider returns roughly 14 m spacing
 *    against a DEM whose own resolution is about 30 m, so the raw array is
 *    oversampled - it carries interpolation, not measurement, between real
 *    cells. `PROFILE_SPACING_METERS` is 60 m, which is at or above the DEM's
 *    resolution and matches the ground spacing the rest of this feature
 *    already samples at (`routeProfile.ts`, GFSC's native pixel).
 *  - **Ignore steps below `MIN_STEP_METERS`.** The measured noise floor was
 *    about 7 m/km - taken from a near-pure descent, where every metre of
 *    reported *ascent* is by definition error. A small threshold removes that
 *    without touching real terrain.
 *
 * Across every reasonable combination of the two, a measured 3.8 km climb of
 * net +412.8 m reported between 429 m and 441 m of ascent - a ~3% spread. That
 * is the honest precision of this number, and it is why `formatAscent` rounds.
 */
import type { ElevationPoint } from "./directionsSchema.ts";

export type { ElevationPoint };

/**
 * Spacing the profile is resampled to before ascent is summed, in metres. See
 * the module docstring: at or above the DEM's own ~30 m resolution, and the
 * same 60 m ground spacing `routeProfile.ts` uses for GFSC.
 */
export const PROFILE_SPACING_METERS = 60;

/**
 * Upward or downward steps smaller than this do not count toward ascent or
 * descent. Set just above the measured ~7 m/km noise floor for a 60 m step,
 * and far below any terrain feature a hiker would notice.
 */
export const MIN_STEP_METERS = 2;

export type ElevationStats = {
  startMeters: number;
  endMeters: number;
  minMeters: number;
  maxMeters: number;
  /** Net difference, end minus start. Robust: errors cancel. */
  netMeters: number;
  /** Cumulative climb, after resampling and thresholding. Treat as approximate. */
  ascentMeters: number;
  /** Cumulative drop, same treatment. */
  descentMeters: number;
};

/**
 * Evenly spaced samples of a profile, in metres along the route.
 *
 * The first and last points are preserved exactly - they are the endpoints the
 * user chose, and the last one in particular is usually the summit or hut that
 * motivated the whole route, so approximating it would be a real defect rather
 * than rounding. Intermediate points are linearly interpolated.
 *
 * Input must be sorted by `distanceMeters` (the provider returns it that way).
 * A profile shorter than two points, or one with no length, is returned
 * unchanged: there is nothing to resample and nothing to invent.
 */
export function resampleProfile(
  points: readonly ElevationPoint[],
  spacingMeters: number = PROFILE_SPACING_METERS,
): ElevationPoint[] {
  if (points.length < 2 || spacingMeters <= 0) return [...points];
  const total = points[points.length - 1].distanceMeters - points[0].distanceMeters;
  if (total <= 0) return [...points];

  const start = points[0].distanceMeters;
  const out: ElevationPoint[] = [];
  let cursor = 1;
  const steps = Math.floor(total / spacingMeters);
  for (let i = 0; i <= steps; i += 1) {
    const target = start + i * spacingMeters;
    while (cursor < points.length - 1 && points[cursor].distanceMeters < target) cursor += 1;
    const before = points[cursor - 1];
    const after = points[cursor];
    const span = after.distanceMeters - before.distanceMeters;
    const t = span > 0 ? (target - before.distanceMeters) / span : 0;
    out.push({
      distanceMeters: target,
      elevationMeters: before.elevationMeters + (after.elevationMeters - before.elevationMeters) * t,
    });
  }
  // Always finish on the real last point rather than the last whole step.
  const last = points[points.length - 1];
  if (out[out.length - 1].distanceMeters < last.distanceMeters) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

/**
 * Start, end, min, max, net, ascent and descent for a profile.
 *
 * Ascent and descent are computed on a resampled, thresholded copy - see the
 * module docstring for why both steps exist. Everything else is read from the
 * profile as given, because none of it accumulates error.
 */
export function elevationStats(
  points: readonly ElevationPoint[],
  options: { spacingMeters?: number; minStepMeters?: number } = {},
): ElevationStats | null {
  if (points.length === 0) return null;

  const startMeters = points[0].elevationMeters;
  const endMeters = points[points.length - 1].elevationMeters;
  let minMeters = startMeters;
  let maxMeters = startMeters;
  for (const point of points) {
    if (point.elevationMeters < minMeters) minMeters = point.elevationMeters;
    if (point.elevationMeters > maxMeters) maxMeters = point.elevationMeters;
  }

  const spacing = options.spacingMeters ?? PROFILE_SPACING_METERS;
  const threshold = options.minStepMeters ?? MIN_STEP_METERS;
  const sampled = resampleProfile(points, spacing);

  let ascentMeters = 0;
  let descentMeters = 0;
  // `reference` is the last elevation actually committed to, not the previous
  // sample: without that, a long steady climb taken in sub-threshold steps
  // would be discarded entirely rather than accumulated.
  let reference = sampled[0]?.elevationMeters ?? startMeters;
  for (const point of sampled) {
    const delta = point.elevationMeters - reference;
    if (Math.abs(delta) < threshold) continue;
    if (delta > 0) ascentMeters += delta;
    else descentMeters -= delta;
    reference = point.elevationMeters;
  }

  return {
    startMeters,
    endMeters,
    minMeters,
    maxMeters,
    netMeters: endMeters - startMeters,
    ascentMeters,
    descentMeters,
  };
}

/**
 * An ascent or descent figure as it should be shown to a person.
 *
 * Rounded to the nearest 10 m, because the measurement is not better than that
 * (a ~3% spread across sampling choices on a 400 m climb is more than 10 m, so
 * this is if anything generous) and a figure like "437 m" claims a precision
 * that would be a small lie. Below 10 m it reads as flat rather than as a
 * suspiciously specific tiny number.
 */
export function formatAscent(meters: number): string {
  if (meters < 10) return "flat";
  return `${Math.round(meters / 10) * 10} m`;
}

/** A height for display: whole metres, which is finer than the DEM is accurate. */
export function formatElevation(meters: number): string {
  return `${Math.round(meters)} m`;
}

/**
 * The elevation at a given distance along the profile, linearly interpolated,
 * for the linked map/profile interaction (spec section 8.5). Out-of-range input
 * clamps to the ends rather than returning null - a finger that overshoots the
 * chart should read the summit, not nothing.
 */
export function elevationAtDistance(
  points: readonly ElevationPoint[],
  distanceMeters: number,
): number | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0].elevationMeters;

  const first = points[0];
  const last = points[points.length - 1];
  if (distanceMeters <= first.distanceMeters) return first.elevationMeters;
  if (distanceMeters >= last.distanceMeters) return last.elevationMeters;

  for (let i = 1; i < points.length; i += 1) {
    if (distanceMeters <= points[i].distanceMeters) {
      const before = points[i - 1];
      const after = points[i];
      const span = after.distanceMeters - before.distanceMeters;
      const t = span > 0 ? (distanceMeters - before.distanceMeters) / span : 0;
      return before.elevationMeters + (after.elevationMeters - before.elevationMeters) * t;
    }
  }
  return last.elevationMeters;
}
