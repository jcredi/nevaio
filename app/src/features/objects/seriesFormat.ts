/**
 * Frontend mirror of `pipeline/src/nevaio_pipeline/object_series.py` - the
 * `series/<TILE>/<YYYY-MM>.bin` cell format (spec section 7.1).
 *
 * This is the contract, not a reinterpretation of it: object-major, a fixed
 * 2-byte cell per calendar day (byte 0 the raw GF pixel value from *that
 * day's own* GFSC product, byte 1 packed GF-QA in bits 0-1 and AT age code in
 * bits 2-5), one column per day of the month, so one object's whole month is
 * a single contiguous byte range at an offset that depends only on the
 * object's permanent slot (`nevaio_pipeline.object_slots`) and the day of
 * month. See that module's docstring for the full derivation; this file keeps
 * every constant and every branch in the same order as `decode_cell` there so
 * the two can never quietly drift.
 *
 * **Every byte pair decodes to something** - there is no "invalid cell", only
 * the four states spec 7.1 requires the chart to distinguish. That is also
 * why this module can be a plain decoder: the one thing that *can* be
 * malformed is the buffer's length (an HTTP response body is arbitrary
 * bytes), so `decodeMonthBuffer` is the actual validation gate for anything
 * that arrived over the network - see `seriesClient.ts`, which is where the
 * bytes in question actually come from.
 *
 * Pure and dependency-free (only `./isoDate.ts`, itself pure): `npm test`
 * runs this directly under Node.
 */
import { daysInMonth as calendarDaysInMonth } from "./isoDate.ts";

/** Bytes per object per day: [GF byte, packed GF-QA/AT-age byte]. */
export const CELL_SIZE = 2;

/** GFSC's own "cloud" code (`nevaio_pipeline.asof.CLOUD`), stored verbatim. */
export const CLOUD_GF_BYTE = 205;

/** Spec 7.1 caps mark validity at 14 days of AT age; 15 is the "n/a" sentinel. */
export const MAX_VALID_AGE_DAYS = 14;
const AGE_NOT_APPLICABLE = 15;

/** What one decoded cell means to the chart (spec section 7.1). */
export type SeriesMarkState = "valid" | "cloud" | "no_data" | "stale";

/**
 * GF-QA 0-3 by name (spec section 4, `docs/research/gfsc-findings.md`): the
 * primary indicator of how much gap-filling a pixel involved, never a proxy
 * for age. Index this array with a decoded `quality` value.
 */
export const QUALITY_TIER_LABELS = ["High", "Medium", "Low", "Minimal"] as const;

/** A decoded cell. Only `valid` (and, for detail views, `stale`) carry values. */
export type SeriesCell = {
  state: SeriesMarkState;
  /** 0-100, or null when the day carries nothing plottable. */
  gf: number | null;
  /** 0-3 GF-QA, meaningful only alongside a non-null `gf`. */
  quality: number | null;
  /** Observation age in days, present only for `valid` marks. */
  ageDays: number | null;
};

export class SeriesFormatError extends Error {}

/**
 * Decode one 2-byte cell. Mirrors `object_series.decode_cell` branch for
 * branch:
 *
 * - `cloud`: byte 0 == 205.
 * - `no_data`: byte 0 is anything else outside 0-100 (GFSC's water/no-data
 *   codes, an unrecognized raw value, or the "no product that day" sentinel -
 *   all genuinely absent, all a gap).
 * - `stale`: byte 0 in 0-100 but the age code is the "n/a" sentinel (15) -
 *   either the real age exceeded 14 days, or QA/AT itself was unusable even
 *   though GF was present. A gap, not a mark; GF/quality are kept for detail.
 * - `valid`: byte 0 in 0-100, age code in 0-14 - the only state the chart may
 *   plot a discrete mark for.
 */
export function decodeCell(gfByte: number, packedByte: number): SeriesCell {
  if (!Number.isInteger(gfByte) || gfByte < 0 || gfByte > 255) {
    throw new SeriesFormatError(`GF byte must be an integer 0-255, got ${gfByte}`);
  }
  if (!Number.isInteger(packedByte) || packedByte < 0 || packedByte > 255) {
    throw new SeriesFormatError(`packed byte must be an integer 0-255, got ${packedByte}`);
  }

  const quality = packedByte & 0b11;
  const ageCode = (packedByte >> 2) & 0b1111;

  if (gfByte === CLOUD_GF_BYTE) {
    return { state: "cloud", gf: null, quality: null, ageDays: null };
  }
  if (gfByte < 0 || gfByte > 100) {
    return { state: "no_data", gf: null, quality: null, ageDays: null };
  }
  if (ageCode === AGE_NOT_APPLICABLE) {
    return { state: "stale", gf: gfByte, quality, ageDays: null };
  }
  return { state: "valid", gf: gfByte, quality, ageDays: ageCode };
}

/**
 * Decode a whole month buffer (or any contiguous run of cells) into one entry
 * per day, in order. Throws if the buffer is not a whole number of cells -
 * the one shape error a network response can actually have, since every byte
 * value is individually a valid cell.
 */
export function decodeMonthBuffer(bytes: Uint8Array): SeriesCell[] {
  if (bytes.length % CELL_SIZE !== 0) {
    throw new SeriesFormatError(
      `a series buffer must hold whole ${CELL_SIZE}-byte cells, got ${bytes.length} byte(s)`,
    );
  }
  const cells: SeriesCell[] = [];
  for (let offset = 0; offset < bytes.length; offset += CELL_SIZE) {
    cells.push(decodeCell(bytes[offset], bytes[offset + 1]));
  }
  return cells;
}

/** Re-exported under the name this format's own docs use elsewhere. */
export const daysInCalendarMonth = calendarDaysInMonth;

/**
 * Byte offset and length of one object's whole month, i.e. exactly what an
 * HTTP Range request asks for. Mirrors `object_series.object_month_range`.
 *
 * A Range read past the end of an *older* month file is not this function's
 * problem to detect - see the module docstring on the Python side and
 * `seriesClient.ts` here: it means the object had no slot that month, and the
 * client must read the resulting 416 (or short read) as no-data, not as an
 * error.
 */
export function objectMonthRange(slotIndex: number, days: number): { start: number; length: number } {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) {
    throw new SeriesFormatError(`slot_index must be a non-negative integer, got ${slotIndex}`);
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new SeriesFormatError(`days must be a positive integer, got ${days}`);
  }
  const length = days * CELL_SIZE;
  return { start: slotIndex * length, length };
}

/** Byte offset of one object's one day (`dayIndex` is 0-based) within a month buffer. */
export function cellOffset(slotIndex: number, dayIndex: number, days: number): number {
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days) {
    throw new SeriesFormatError(`day_index ${dayIndex} is out of range for a ${days}-day month`);
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0) {
    throw new SeriesFormatError(`slot_index must be a non-negative integer, got ${slotIndex}`);
  }
  return (slotIndex * days + dayIndex) * CELL_SIZE;
}

/** One calendar month, 1-indexed like a human would say it. */
export type YearMonth = { year: number; month: number };

/** `YYYY-MM`, matching the `.bin` filename's own stem. */
export function monthKey(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}`;
}

export function yearMonthOfIso(iso: string): YearMonth {
  const [year, month] = iso.split("-").map(Number);
  return { year, month };
}

/** 0-based day-of-month for an ISO date, matching `dayIndex` above. */
export function dayIndexOfIso(iso: string): number {
  return Number(iso.slice(8, 10)) - 1;
}

/** Every calendar month touched by an inclusive `[startIso, endIso]` range, in order. */
export function monthsBetween(startIso: string, endIso: string): YearMonth[] {
  const months: YearMonth[] = [];
  let { year, month } = yearMonthOfIso(startIso);
  const end = yearMonthOfIso(endIso);
  while (year < end.year || (year === end.year && month <= end.month)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}
