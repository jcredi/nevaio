/**
 * The loading boundary for one object's snow-history series (spec section
 * 7.1). Everything provider-specific - the slot map, the `.bin` Range reads,
 * how a missing month is told apart from a broken request - lives here.
 *
 * Layout, mirroring `pipeline/src/nevaio_pipeline/object_series.py` and
 * `object_slots.py` exactly (see `seriesFormat.ts` and `slotMapSchema.ts` for
 * the decoded shapes):
 *
 *   `<seriesBaseUrl>/slots/<TILE>.json`           - permanent id -> row slot
 *   `<seriesBaseUrl>/series/<TILE>/<YYYY-MM>.bin` - one calendar month, object-major
 *
 * The whole point of the object-major layout (`docs/plan.md` item 1,
 * `object_series.object_month_range`) is that one object's whole month is a
 * single contiguous byte range - a 62-byte read for a 31-day month - so the
 * frontend never downloads another object's history to read one object's own.
 * This client issues an HTTP `Range` request for exactly that range
 * (`worklog.md` 2026-09-12 measured that R2 answers a 62-byte ranged GET with
 * `206` and the right bytes, with CORS intact).
 *
 * **The one contract rule that is not an ordinary HTTP error**: a Range read
 * past the end of an *older* month file means the object had no slot that
 * month (it was not in the OSM extract yet) - genuine absence, not failure.
 * `object_month_range`'s docstring is the authority on why this is safe:
 * offsets depend only on the object's own permanent slot, and slots are
 * append-only, so a slot allocated later is necessarily past an older month's
 * length. This client therefore treats an HTTP 416, a 404 on the month file
 * itself, and a response shorter than the requested range the same way: that
 * whole month is a gap, decoded as `no_data` for every day in it, never as a
 * load failure.
 *
 * **Only a `206` is trusted as the requested bytes.** An earlier version of
 * this client fell back to slicing a `200` response client-side, reasoning
 * that a server might ignore `Range` and return the whole file - but a `200`
 * to a Range request is exactly what a dev server's SPA fallback returns for
 * a *missing* path too (measured locally: an existing `.bin` answers `206`;
 * a nonexistent one answers `200 text/html`, and slicing that would have
 * decoded arbitrary HTML bytes as a snow reading). R2 already answers a real
 * Range request with `206` (`docs/worklog.md`, 2026-09-12), so nothing this
 * app actually talks to needs the fallback, and the failure mode of removing
 * it - occasionally missing bytes a Range-ignoring server could have served -
 * is far cheaper than the failure mode of keeping it.
 *
 * This module is not one of the pure, Node-tested layers (`seriesFormat.ts`,
 * `seriesPresets.ts`, `seriesChartLayout.ts`): it does real `fetch` calls, the
 * same posture `objectIndex.ts` takes for the shard loader it mirrors. It is
 * exercised by `npm run build` (type-checked) and manual verification against
 * a real publication, not by `npm test` - there is no published series to
 * fetch yet (see `docs/plan.md` item 1).
 */
import {
  daysInCalendarMonth,
  decodeMonthBuffer,
  monthKey,
  monthsBetween,
  objectMonthRange,
  type SeriesCell,
} from "./seriesFormat.ts";
import { SlotMapError, slotFor, validateSlotMap, type SlotMap } from "./slotMapSchema.ts";

export type DayCell = { date: string; cell: SeriesCell };

/** A day with nothing plottable and no distinguishing detail - the honest default. */
function noDataCell(): SeriesCell {
  return { state: "no_data", gf: null, quality: null, ageDays: null };
}

export class SeriesLoadError extends Error {}

/** Bound the slot map fetch the way `objectIndex.ts` bounds a shard. */
const MAX_SLOT_MAP_BYTES = 4 * 1024 * 1024;
/** One object-month range is at most 31 days * 2 bytes; a full tile-month fallback (no Range support) is bigger. */
const MAX_MONTH_FALLBACK_BYTES = 4 * 1024 * 1024;

async function fetchJson(url: string, limit: number, what: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch (error) {
    throw new SeriesLoadError(`could not fetch ${what}: ${String(error)}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new SeriesLoadError(`${what} request failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new SeriesLoadError(`${what} declares ${declared} bytes, over the ${limit} limit`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > limit) {
    throw new SeriesLoadError(`${what} is ${body.byteLength} bytes, over the ${limit} limit`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new SeriesLoadError(`${what} is not valid JSON: ${String(error)}`);
  }
}

/**
 * Fetch exactly `[start, start + length)` of `url` via HTTP `Range`.
 *
 * Returns `null` for the documented gap cases (416, 404, a response shorter
 * than requested), and the exact `length`-byte slice otherwise - including
 * when the server ignores `Range` and answers `200` with the whole file, in
 * which case the slice is cut out client-side.
 */
async function fetchRange(url: string, start: number, length: number, what: string): Promise<Uint8Array | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-cache",
      headers: { Range: `bytes=${start}-${start + length - 1}` },
    });
  } catch (error) {
    throw new SeriesLoadError(`could not fetch ${what}: ${String(error)}`);
  }
  // 404/416 are the documented gap case.
  if (response.status === 404 || response.status === 416) return null;
  // A real server error is still a load failure, not a gap - the caller
  // should say "could not load", not silently draw an empty chart.
  if (!response.ok) throw new SeriesLoadError(`${what} request failed: HTTP ${response.status}`);
  // Anything `ok` that is not exactly a 206 partial response is *not* trusted
  // as the requested bytes either - see the module docstring: a 200 here is
  // indistinguishable from a server that never had this path at all (a
  // dev-server SPA fallback, a caching proxy) and from a server that
  // genuinely served the whole file, and guessing wrong means decoding
  // unrelated bytes as a snow reading.
  if (response.status !== 206) {
    console.warn(`${what}: expected HTTP 206 for a Range request, got ${response.status} - treating as no data`);
    return null;
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MONTH_FALLBACK_BYTES) {
    throw new SeriesLoadError(`${what} declares ${declared} bytes, over the ${MAX_MONTH_FALLBACK_BYTES} limit`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_MONTH_FALLBACK_BYTES) {
    throw new SeriesLoadError(`${what} is ${body.byteLength} bytes, over the ${MAX_MONTH_FALLBACK_BYTES} limit`);
  }
  // A correctly-served partial response should be exactly `length` bytes;
  // shorter means the file ended before this object's range did - the same
  // "no slot that month" gap a 416 would signal.
  return body.length >= length ? body.subarray(0, length) : null;
}

/**
 * Loads and caches per-tile slot maps and per-object-month byte ranges, and
 * assembles the day-by-day series a chart preset needs.
 *
 * `seriesBaseUrl` is the one trust anchor, exactly like the object index and
 * snow manifest URLs: it comes from build-time configuration
 * (`VITE_OBJECT_SERIES_URL`), never from the network, and every request this
 * class makes is relative to it. `pageUrl` resolves it when it is itself a
 * relative path (the local-dev shape), the same role `ObjectIndexStore`'s own
 * `pageUrl` plays for the object index.
 */
export class SeriesClient {
  private readonly slotMaps = new Map<string, Promise<SlotMap | null>>();
  private readonly monthCells = new Map<string, Promise<SeriesCell[] | null>>();

  constructor(
    private readonly seriesBaseUrl: string,
    private readonly pageUrl: string,
  ) {}

  private base(): URL {
    const withSlash = this.seriesBaseUrl.endsWith("/") ? this.seriesBaseUrl : `${this.seriesBaseUrl}/`;
    return new URL(withSlash, this.pageUrl);
  }

  private async loadSlotMap(tile: string): Promise<SlotMap | null> {
    const cached = this.slotMaps.get(tile);
    if (cached) return cached;
    const promise = (async () => {
      const url = new URL(`slots/${tile}.json`, this.base()).href;
      const document = await fetchJson(url, MAX_SLOT_MAP_BYTES, `slot map for ${tile}`);
      if (document === null) return null;
      try {
        return validateSlotMap(document, tile);
      } catch (error) {
        if (error instanceof SlotMapError) throw new SeriesLoadError(error.message);
        throw error;
      }
    })();
    this.slotMaps.set(tile, promise);
    return promise;
  }

  /**
   * One object's decoded cells for one calendar month, or `null` for the
   * documented gap case (no slot that month, file not published yet, or a
   * short read) - see the module docstring.
   */
  private async loadObjectMonth(tile: string, year: number, month: number, slot: number): Promise<SeriesCell[] | null> {
    const key = `${tile}/${year}-${month}/${slot}`;
    const cached = this.monthCells.get(key);
    if (cached) return cached;
    const promise = (async () => {
      const days = daysInCalendarMonth(year, month);
      const { start, length } = objectMonthRange(slot, days);
      const url = new URL(`series/${tile}/${monthKey({ year, month })}.bin`, this.base()).href;
      const bytes = await fetchRange(url, start, length, `series for ${key}`);
      if (bytes === null) return null;
      return decodeMonthBuffer(bytes);
    })();
    this.monthCells.set(key, promise);
    return promise;
  }

  /**
   * The day-by-day series for one object over `[startIso, endIso]` inclusive,
   * one entry per calendar day with no gaps in the array itself - a day with
   * no data at all is a `no_data` cell, never a missing entry (that is what
   * lets `seriesChartLayout.ts` treat "adjacent in this array" and "adjacent
   * on the calendar" as the same fact).
   *
   * Never throws for missing data: an unpublished slot map, an object with no
   * slot, or a month file that is not there yet all resolve to `no_data` days
   * rather than an exception, because "this object has no history for this
   * range" is an ordinary, expected outcome long before the backfill
   * (`docs/plan.md` item 1) reaches every tile and every month. A genuine
   * network/parse failure still throws `SeriesLoadError`.
   */
  async loadRange(tile: string, objectId: string, startIso: string, endIso: string): Promise<DayCell[]> {
    const slotMap = await this.loadSlotMap(tile);
    const slot = slotMap ? slotFor(slotMap, objectId) : null;

    const days: DayCell[] = [];
    for (const { year, month } of monthsBetween(startIso, endIso)) {
      const cells = slot === null ? null : await this.loadObjectMonth(tile, year, month, slot);
      const dim = daysInCalendarMonth(year, month);
      for (let dayIndex = 0; dayIndex < dim; dayIndex += 1) {
        const date = addDaysToMonthStart(year, month, dayIndex);
        if (date < startIso || date > endIso) continue;
        days.push({ date, cell: cells?.[dayIndex] ?? noDataCell() });
      }
    }
    return days;
  }
}

/** The `offset`-th day (0-based) of `year`/`month`, as an ISO date. */
function addDaysToMonthStart(year: number, month: number, offset: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1 + offset));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}
