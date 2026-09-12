/**
 * Plain-date arithmetic on `YYYY-MM-DD` strings, all UTC.
 *
 * Shared by `seriesFormat.ts` (which month a day falls in) and
 * `seriesPresets.ts` (preset/custom date ranges). This is general-purpose
 * pure math, not one of the three network-facing validators
 * (`features/snow/manifestSchema.ts`, `features/snow/dateCatalogueSchema.ts`,
 * `features/objects/objectIndexSchema.ts`) that deliberately keep their own
 * copies of shared helpers - this module has no network or trust surface, so
 * sharing it carries none of the risk that duplication rule guards against.
 *
 * Every function treats its input as a calendar date with no time-of-day or
 * timezone, matching how `asOfDate`/`dates.json` already work elsewhere in
 * this app. No `import.meta.env`, no DOM: `npm test` runs this directly under
 * Node.
 */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parts(iso: string): [number, number, number] {
  if (!ISO_DATE.test(iso)) throw new RangeError(`not an ISO date: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

const MS_PER_DAY = 86_400_000;

/** Days since the Unix epoch, UTC - the same unit AT age is compared against server-side. */
export function isoToEpochDay(iso: string): number {
  const [y, m, d] = parts(iso);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function epochDayToIso(epochDay: number): string {
  const date = new Date(epochDay * MS_PER_DAY);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** How many days a calendar month has - handles leap Februaries via day-0-of-next-month. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDaysIso(iso: string, deltaDays: number): string {
  return epochDayToIso(isoToEpochDay(iso) + deltaDays);
}
