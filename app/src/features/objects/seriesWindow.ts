/**
 * The one period the snow history chart shows: the trailing 30-day window
 * ending on the map's own AS-OF date.
 *
 * **Spec amendment v1.13 (2026-09-12) reduced section 7.1 to this single
 * window.** The frozen text had offered last 30 days, last 90 days, last year,
 * a custom period and a comparable period in a previous year; the owner
 * dropped all but the first. Do not reintroduce a picker without a further
 * amendment - and note the consequence recorded in `docs/plan.md`: the
 * backfill only has to reach back far enough to fill this window, not the two
 * years the previous-year comparison would have required.
 *
 * Anchored on the AS-OF date, not `Date.now()`, so a chart opened against a
 * historical AS-OF (spec section 5.3) shows history ending there rather than
 * today.
 *
 * No `import.meta.env`, no DOM: `npm test` runs this directly under Node.
 */
import { addDaysIso, ISO_DATE } from "./isoDate.ts";

export type DateRange = {
  /** Inclusive, `YYYY-MM-DD`. */
  start: string;
  /** Inclusive, `YYYY-MM-DD`. */
  end: string;
};

export class WindowRangeError extends Error {}

/**
 * 30 rather than 31: "the last 30/31 days" as asked for is a month-ish
 * window, and a fixed 30 keeps the window the same length whatever month it
 * ends in. A month `.bin` still holds up to 31 columns - that is the storage
 * layout, not this window.
 */
export const HISTORY_WINDOW_DAYS = 30;

/** The trailing `days`-day window ending on (and including) `asOfIso`. */
export function trailingRange(asOfIso: string, days: number = HISTORY_WINDOW_DAYS): DateRange {
  if (!ISO_DATE.test(asOfIso)) {
    throw new WindowRangeError(`asOfIso must be an ISO date, got ${asOfIso}`);
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new WindowRangeError(`days must be a positive integer, got ${days}`);
  }
  return { start: addDaysIso(asOfIso, -(days - 1)), end: asOfIso };
}
