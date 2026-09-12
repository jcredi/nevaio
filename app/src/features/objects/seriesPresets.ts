/**
 * Chart period presets for the snow history chart (spec section 7.1): "last
 * 30 days", "last 90 days", "last year", a custom period, and the
 * previous-year comparison. Pure date math, anchored on the map's own AS-OF
 * date (not `Date.now()`) so a chart opened against a historical AS-OF (spec
 * section 5.3) shows history ending there, not "today".
 *
 * No `import.meta.env`, no DOM: `npm test` runs this directly under Node.
 */
import { addDaysIso, compareIso, diffDaysIso, ISO_DATE, shiftYearsIso } from "./isoDate.ts";

export type FixedPresetId = "last30" | "last90" | "lastYear";
export type PresetId = FixedPresetId | "custom";

export type DateRange = {
  /** Inclusive, `YYYY-MM-DD`. */
  start: string;
  /** Inclusive, `YYYY-MM-DD`. */
  end: string;
};

export class PresetRangeError extends Error {}

/** Longest span a custom period may request - a year and a bit, generous for spec 7.1's own "last year" preset. */
export const MAX_CUSTOM_RANGE_DAYS = 400;

/** Fixed-length presets, in the order the picker should offer them. */
export const FIXED_PRESETS: { id: FixedPresetId; label: string; days: number }[] = [
  { id: "last30", label: "Last 30 days", days: 30 },
  { id: "last90", label: "Last 90 days", days: 90 },
  { id: "lastYear", label: "Last year", days: 365 },
];

function requireIso(value: string, field: string): void {
  if (!ISO_DATE.test(value)) throw new PresetRangeError(`${field} must be an ISO date, got ${value}`);
}

/** The trailing `days`-day window ending on (and including) `asOfIso`. */
export function trailingRange(asOfIso: string, days: number): DateRange {
  requireIso(asOfIso, "asOfIso");
  if (!Number.isInteger(days) || days < 1) {
    throw new PresetRangeError(`days must be a positive integer, got ${days}`);
  }
  return { start: addDaysIso(asOfIso, -(days - 1)), end: asOfIso };
}

export function fixedPresetRange(preset: FixedPresetId, asOfIso: string): DateRange {
  const spec = FIXED_PRESETS.find((entry) => entry.id === preset);
  if (!spec) throw new PresetRangeError(`unknown fixed preset ${preset}`);
  return trailingRange(asOfIso, spec.days);
}

/**
 * A user-chosen `[startIso, endIso]`, inclusive. Rejects a reversed pair and
 * an implausibly long span up front, both to keep `seriesClient.ts` from ever
 * being asked to fetch an unbounded number of months and because a reversed
 * range is a UI bug, not a legitimate request.
 */
export function customRange(startIso: string, endIso: string): DateRange {
  requireIso(startIso, "startIso");
  requireIso(endIso, "endIso");
  if (compareIso(startIso, endIso) > 0) {
    throw new PresetRangeError(`start ${startIso} is after end ${endIso}`);
  }
  const spanDays = diffDaysIso(startIso, endIso) + 1;
  if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
    throw new PresetRangeError(`range spans ${spanDays} days, over the ${MAX_CUSTOM_RANGE_DAYS}-day limit`);
  }
  return { start: startIso, end: endIso };
}

/**
 * Spec 7.1's "comparable period in a previous year" - the same range, shifted
 * back one calendar year (Feb 29 clamps to Feb 28 in a non-leap target year,
 * rather than overflowing into March - see `isoDate.shiftYearsIso`).
 *
 * "Where data availability permits" is a runtime fact about what the series
 * actually holds, not something date math can decide - `seriesClient.ts`
 * surfaces that as ordinary gaps (no_data) rather than this function refusing
 * to compute a range.
 */
export function previousYearRange(range: DateRange): DateRange {
  return { start: shiftYearsIso(range.start, -1), end: shiftYearsIso(range.end, -1) };
}
