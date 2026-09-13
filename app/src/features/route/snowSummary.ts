/**
 * Route-level snow statistics (spec section 8.4), pure and Node-tested.
 *
 * **The rule this module exists to enforce**: a sample with no observation is
 * never counted as a sample with no snow. Spec section 5.4 is explicit that the
 * app "must not confuse unavailable observations with 0% snow", and a summary
 * statistic is the easiest place in the whole app to do exactly that by
 * accident - dividing by the number of samples rather than the number of
 * *observed* samples turns cloud into bare ground, silently, and makes a route
 * look safer the worse the data is.
 *
 * So every figure here is reported against its own denominator, and the
 * coverage fraction is reported alongside so a reader can see how much of the
 * route the figures actually rest on. A route that is 90% cloud gets a
 * percentage that says so, not a confident number over 10% of the ground.
 *
 * Spec section 15 item 11 requires observation freshness *and* quality shown
 * "clearly and prominently" on the profile - strengthened from "where
 * practical" on 2026-09-11 - so both are summarised here rather than left to a
 * detail view.
 *
 * The "snow-covered percentage" definition is spec section 15 item 2, still
 * open. This module implements a threshold (`SNOW_THRESHOLD_PERCENT`) and names
 * it, rather than pretending the question is closed; see the constant.
 */
import { SnowDataState, type SnowDataCell } from "./snowDataTile.ts";

/**
 * A sample counts as snow-covered at or above this fractional cover.
 *
 * 50% is a placeholder with a reason, not a decision: at GFSC's 60 m pixel, a
 * cell at 50% is as likely to be a continuous patchy snowfield as bare ground
 * with drifts, and picking the midpoint avoids claiming either. Spec section 15
 * item 2 leaves the real definition open, and it should be settled against
 * measurements and against what a mountaineer actually needs to decide - not
 * here.
 */
export const SNOW_THRESHOLD_PERCENT = 50;

export type SnowSummary = {
  /** Samples with a real observation - the denominator for everything below. */
  observedSamples: number;
  /** Every sample taken, observed or not. */
  totalSamples: number;
  /** Fraction of the route that carries any observation at all, 0-1. */
  coverage: number;
  /** Mean fractional cover across observed samples, 0-100, or null if none. */
  meanCoverPercent: number | null;
  /** Fraction of *observed* samples at or above the threshold, 0-1, or null. */
  snowFraction: number | null;
  /** Longest run of consecutive observed, snow-covered samples, in samples. */
  longestSnowRun: number;
  /** Worst (largest) observation age across observed samples, or null. */
  maxAgeDays: number | null;
  /** Worst (numerically largest, i.e. lowest) QA tier observed, or null. */
  worstQuality: number | null;
  /** How many samples fell in each state, so nothing is silently dropped. */
  stateCounts: Record<SnowDataState, number>;
};

function emptyStateCounts(): Record<SnowDataState, number> {
  return {
    [SnowDataState.Valid]: 0,
    [SnowDataState.Cloud]: 0,
    [SnowDataState.Water]: 0,
    [SnowDataState.NoData]: 0,
    [SnowDataState.Stale]: 0,
  };
}

/**
 * Summarise snow along a route.
 *
 * `cells` is one sample per evenly spaced point along the route, so counting
 * samples is proportional to counting distance - that equivalence is why
 * `routeProfile.ts` insists on even spacing in ground metres, and it is what
 * makes `longestSnowRun` convertible to a distance by the caller.
 */
export function summariseSnow(cells: readonly SnowDataCell[]): SnowSummary {
  const stateCounts = emptyStateCounts();
  let observedSamples = 0;
  let coverSum = 0;
  let snowSamples = 0;
  let longestSnowRun = 0;
  let currentRun = 0;
  let maxAgeDays: number | null = null;
  let worstQuality: number | null = null;

  for (const cell of cells) {
    stateCounts[cell.state] += 1;

    if (cell.state !== SnowDataState.Valid || cell.fsc === null) {
      // Not observed. It breaks a snow run rather than extending it: two snowy
      // stretches either side of a cloud bank are not one continuous snowfield,
      // and claiming they are would be inventing the bit in the middle.
      currentRun = 0;
      continue;
    }

    observedSamples += 1;
    coverSum += cell.fsc;
    if (cell.ageDays !== null) {
      maxAgeDays = maxAgeDays === null ? cell.ageDays : Math.max(maxAgeDays, cell.ageDays);
    }
    if (cell.quality !== null) {
      // Tier 0 is best, 3 worst, so the worst tier is the numeric maximum.
      worstQuality = worstQuality === null ? cell.quality : Math.max(worstQuality, cell.quality);
    }

    if (cell.fsc >= SNOW_THRESHOLD_PERCENT) {
      snowSamples += 1;
      currentRun += 1;
      longestSnowRun = Math.max(longestSnowRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  const totalSamples = cells.length;
  return {
    observedSamples,
    totalSamples,
    coverage: totalSamples === 0 ? 0 : observedSamples / totalSamples,
    // Both of these divide by the *observed* count, never the total - see the
    // module docstring. Null rather than 0 when nothing was observed: "we do
    // not know" and "no snow" are different answers.
    meanCoverPercent: observedSamples === 0 ? null : coverSum / observedSamples,
    snowFraction: observedSamples === 0 ? null : snowSamples / observedSamples,
    longestSnowRun,
    maxAgeDays,
    worstQuality,
    stateCounts,
  };
}

/**
 * A one-line headline for the panel, or null when there is nothing to say.
 *
 * Deliberately refuses to produce a headline below `MIN_COVERAGE_FOR_HEADLINE`:
 * a confident "12% of this route has snow" computed from a tenth of the route
 * is worse than admitting the route is mostly unobserved, and this is exactly
 * the summary statistic spec section 8.4 warns is easy to get wrong.
 */
export const MIN_COVERAGE_FOR_HEADLINE = 0.5;

export function snowHeadline(summary: SnowSummary): string | null {
  if (summary.observedSamples === 0 || summary.snowFraction === null) return null;
  if (summary.coverage < MIN_COVERAGE_FOR_HEADLINE) return null;
  const percent = Math.round(summary.snowFraction * 100);
  if (percent === 0) return "No snow on the observed parts of this route";
  return `About ${percent}% of the observed route is snow-covered`;
}
