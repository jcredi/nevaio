/**
 * Lay the AS-OF catalogue out as calendar weeks, for the date picker's popup.
 *
 * Pure and Node-tested, for the same reason every other layout helper in this
 * app is: the interesting part is the arithmetic, not the DOM.
 *
 * **The grid covers the catalogue's own span, not a calendar month.** The
 * window is up to `ASOF_CATALOGUE_DATES` (31) days and routinely straddles two
 * months, so a month view would need month-to-month navigation and would show
 * the user a lot of days they can never pick. Laying out exactly the span from
 * the oldest available date to the newest - padded to whole weeks so the
 * columns line up under their weekday headings - means the whole choice is on
 * screen at once with no navigation at all.
 *
 * **A day inside the span can still be unavailable.** A day whose run failed
 * leaves a hole, and the catalogue is authoritative about that (see
 * `catalogue.py`: "a date absent from it is unavailable, full stop"). Those
 * days are rendered present but disabled rather than omitted, because a gap
 * the user can see is information - the alternative is a calendar that
 * silently renumbers itself around missing data.
 *
 * Weeks start on Monday: this app's area is the Alps and the Italian
 * Apennines, where that is the convention.
 */

/** Monday-first, matching the grid's column order. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export type CalendarCell = {
  /** `YYYY-MM-DD`, or null for a padding cell outside the catalogue's span. */
  iso: string | null;
  /** Whether this exact date can be selected. */
  available: boolean;
  /** Day of the month, for the cell's label. Null when `iso` is null. */
  day: number | null;
  /** True on the first cell of a month, so the grid can label the change. */
  monthStart: boolean;
};

const MS_PER_DAY = 86_400_000;

function toUtc(iso: string): number {
  const stamp = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(stamp)) throw new Error(`not a date: ${iso}`);
  return stamp;
}

function toIso(stamp: number): string {
  return new Date(stamp).toISOString().slice(0, 10);
}

/** Monday = 0 ... Sunday = 6, from JavaScript's Sunday = 0. */
function mondayIndex(stamp: number): number {
  return (new Date(stamp).getUTCDay() + 6) % 7;
}

/**
 * Weeks covering every date in `isoDates`, oldest week first.
 *
 * Input order does not matter - the catalogue hands these over newest-first
 * and this reads only the extremes - and duplicates are harmless. An empty
 * input gives an empty grid rather than throwing, because "no dates" is a
 * legitimate catalogue state and the caller already declines to show a picker
 * for it.
 */
export function calendarWeeks(isoDates: readonly string[]): CalendarCell[][] {
  if (isoDates.length === 0) return [];
  const available = new Set(isoDates);
  const stamps = isoDates.map(toUtc);
  const first = Math.min(...stamps);
  const last = Math.max(...stamps);

  // Pad outward to whole Monday-Sunday weeks so every column sits under its
  // own weekday heading.
  const gridStart = first - mondayIndex(first) * MS_PER_DAY;
  const gridEnd = last + (6 - mondayIndex(last)) * MS_PER_DAY;

  const weeks: CalendarCell[][] = [];
  let week: CalendarCell[] = [];
  for (let stamp = gridStart; stamp <= gridEnd; stamp += MS_PER_DAY) {
    const inSpan = stamp >= first && stamp <= last;
    const iso = inSpan ? toIso(stamp) : null;
    const date = new Date(stamp);
    week.push({
      iso,
      available: iso !== null && available.has(iso),
      day: inSpan ? date.getUTCDate() : null,
      monthStart: inSpan && date.getUTCDate() === 1,
    });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) weeks.push(week);
  return weeks;
}

/** The month headings this grid spans, e.g. `"Aug - Sep 2026"`. */
export function calendarTitle(isoDates: readonly string[]): string {
  if (isoDates.length === 0) return "";
  const stamps = isoDates.map(toUtc);
  const first = new Date(Math.min(...stamps));
  const last = new Date(Math.max(...stamps));
  const month = (date: Date): string =>
    date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const year = (date: Date): number => date.getUTCFullYear();
  if (year(first) === year(last) && month(first) === month(last)) {
    return `${month(first)} ${year(first)}`;
  }
  if (year(first) === year(last)) return `${month(first)} - ${month(last)} ${year(last)}`;
  return `${month(first)} ${year(first)} - ${month(last)} ${year(last)}`;
}
