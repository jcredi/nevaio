/**
 * Runtime validation for the public AS-OF date catalogue (`dates.json`).
 *
 * Spec section 5.3 makes this document *authoritative about availability*: a
 * date absent from it is unavailable, and there is no falling back to the
 * latest map, to a nearby date, or to anything recomposed in the browser. That
 * makes it a public contract in exactly the sense `latest.json` is, so it gets
 * the same treatment - exact field sets, bounded size, and every derivable
 * value re-derived rather than trusted.
 *
 * The trust anchor is the catalogue URL itself, which is derived from the
 * build-time snow manifest URL rather than from the network. Each entry's
 * `manifest` is a *relative* key by design, resolved against that URL and
 * required to stay on its origin and in its directory, so a poisoned catalogue
 * can never point the browser at a new host. The deployed CSP in
 * app/public/_headers is the independent second layer.
 *
 * This mirrors the rules in pipeline/src/nevaio_pipeline/artifact_validation.py's
 * `validate_date_catalogue`, which the publisher runs over its own bytes before
 * the PUT. Two implementations of one contract is the point: the publisher
 * cannot advertise a date this rejects without its own CI failing first.
 *
 * The helpers below deliberately duplicate their equivalents in
 * `manifestSchema.ts` and `objects/objectIndexSchema.ts` rather than being
 * shared. Each network-facing validator stays readable and auditable end to
 * end on its own, which is worth more here than removing forty lines.
 */

/** One available AS-OF date, with its archived manifest already resolved. */
export type CatalogueEntry = {
  asOfDate: string;
  runId: string;
  /** Relative key exactly as published, e.g. `asof-2026-09-11-20260911T043500Z.json`. */
  manifest: string;
  /** Absolute URL, checked to be on the catalogue's own origin and directory. */
  manifestUrl: string;
};

/** A validated catalogue. `dates` is newest first and may legally be empty. */
export type DateCatalogue = {
  schemaVersion: number;
  kind: string;
  generatedAt: string;
  maxDates: number;
  dates: CatalogueEntry[];
};

export const CATALOGUE_SCHEMA_VERSION = 1;
export const CATALOGUE_KIND = "asof-date-catalogue";

/** Matches MAX_CATALOGUE_BYTES in artifact_validation.py. */
export const MAX_CATALOGUE_BYTES = 16 * 1024;

const CATALOGUE_FIELDS = ["schemaVersion", "kind", "generatedAt", "maxDates", "dates"];
const ENTRY_FIELDS = ["asOfDate", "runId", "manifest"];

const RUN_ID = /^\d{8}T\d{6}Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// The publisher writes an aware UTC timestamp; accept the two spellings of
// zero offset and nothing else, so a local-time value cannot pass as UTC.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;

// A window wider than a year is not a retention policy, it is a malformed
// document; the shipped policy is 31 (config.ASOF_CATALOGUE_DATES).
const MAX_WINDOW_DAYS = 366;
const MILLISECONDS_PER_DAY = 86_400_000;

export class DateCatalogueError extends Error {}

function fail(message: string): never {
  throw new DateCatalogueError(message);
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.length === 0) fail(`${field} must not be empty`);
  if (value.length > maxLength) {
    fail(`${field} is ${value.length} characters, over the ${maxLength} limit`);
  }
  return value;
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${field} must be an integer`);
  }
  if (value < min || value > max) fail(`${field} must be between ${min} and ${max}`);
  return value;
}

/** Exactly these keys, no more and no fewer - an unknown field is a mismatch. */
function requireFields(value: unknown, field: string, expected: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} must be a JSON object`);
  }
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${field} has fields [${actual.join(", ")}], expected [${wanted.join(", ")}]`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse an ISO calendar date, rejecting anything the calendar does not have.
 *
 * `Date.parse` accepts "2026-02-30" in some engines and rolls it forward, so
 * the parsed value is formatted back and compared: a date that does not
 * round-trip was never a real date.
 */
function requireIsoDate(value: unknown, field: string): { text: string; time: number } {
  const text = requireString(value, field, 10);
  if (!ISO_DATE.test(text)) fail(`${field} is not an ISO date: ${text}`);
  const time = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(time)) fail(`${field} is not a real date: ${text}`);
  if (new Date(time).toISOString().slice(0, 10) !== text) {
    fail(`${field} is not a real date: ${text}`);
  }
  return { text, time };
}

/** The directory the catalogue itself lives in, which its manifests must share. */
function directoryOf(base: URL): string {
  return base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
}

/**
 * Resolve a published manifest key against the catalogue's own URL, refusing
 * anything that changes where the browser would send the request.
 */
function resolveTrustedManifest(key: string, field: string, base: URL): URL {
  let resolved: URL;
  try {
    resolved = new URL(key, base);
  } catch {
    return fail(`${field} is not a resolvable URL`);
  }
  if (resolved.origin !== base.origin) {
    fail(`${field} points at ${resolved.origin}, not the catalogue's own ${base.origin}`);
  }
  if (resolved.protocol !== base.protocol) {
    fail(`${field} changes the scheme to ${resolved.protocol}`);
  }
  if (resolved.username || resolved.password) {
    fail(`${field} must not embed credentials`);
  }
  if (resolved.search || resolved.hash) {
    fail(`${field} must not carry a query string or fragment`);
  }
  // An archived manifest is a sibling of the catalogue, never in a
  // subdirectory: validateTileManifest resolves that date's tiles as
  // `<manifest directory>/runs/<runId>/tiles/...`, so moving the manifest
  // moves the tiles with it.
  const expected = `${directoryOf(base)}${key}`;
  if (resolved.pathname !== expected) {
    fail(`${field} path is ${resolved.pathname}, expected ${expected}`);
  }
  return resolved;
}

/**
 * Where the catalogue lives, given the trusted snow manifest URL.
 *
 * `dates.json` is published beside `latest.json` at the bucket root, so it is
 * derived rather than configured separately: one build-time URL stays the
 * single trust anchor for the whole snow layer, and the two can never be
 * pointed at different hosts by a misconfiguration.
 */
export function dateCatalogueUrlFor(manifestUrl: string, pageUrl: string): string {
  return new URL("dates.json", new URL(manifestUrl, pageUrl)).href;
}

/**
 * Validate the catalogue document and resolve each entry's manifest URL.
 *
 * Takes the raw response text rather than parsed JSON so the size limit is
 * enforced on what actually crossed the network.
 */
export function validateDateCatalogue(
  text: string,
  catalogueUrl: string,
  pageUrl: string,
): DateCatalogue {
  if (typeof text !== "string") fail("catalogue must be text");
  const bytes = new TextEncoder().encode(text).length;
  if (bytes === 0 || bytes > MAX_CATALOGUE_BYTES) {
    fail(`catalogue is ${bytes} bytes, outside the 1-${MAX_CATALOGUE_BYTES} limit`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("catalogue is not valid JSON");
  }
  const source = requireFields(parsed, "catalogue", CATALOGUE_FIELDS);

  if (source.schemaVersion !== CATALOGUE_SCHEMA_VERSION) {
    fail(`unsupported catalogue schemaVersion ${String(source.schemaVersion)}`);
  }
  if (source.kind !== CATALOGUE_KIND) {
    fail(`unexpected catalogue kind ${String(source.kind)}`);
  }

  const generatedAt = requireString(source.generatedAt, "generatedAt", 40);
  if (!UTC_TIMESTAMP.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) {
    fail(`generatedAt is not a UTC timestamp: ${generatedAt}`);
  }

  const maxDates = requireInteger(source.maxDates, "maxDates", 1, MAX_WINDOW_DAYS);

  if (!Array.isArray(source.dates)) fail("dates must be an array");
  // Empty is legal and meaningful: it says nothing is available, which the
  // caller must honour rather than quietly showing the latest map.
  if (source.dates.length > maxDates) {
    fail(`catalogue advertises ${source.dates.length} dates, over its own window of ${maxDates}`);
  }

  const base = new URL(catalogueUrl, pageUrl);
  const times: number[] = [];
  const runIds = new Set<string>();

  const dates = source.dates.map((raw, index): CatalogueEntry => {
    const entry = requireFields(raw, `dates[${index}]`, ENTRY_FIELDS);
    const { text: asOfDate, time } = requireIsoDate(entry.asOfDate, `dates[${index}].asOfDate`);

    const runId = requireString(entry.runId, `dates[${index}].runId`, 32);
    if (!RUN_ID.test(runId)) fail(`dates[${index}].runId is not a UTC run identifier: ${runId}`);
    if (runIds.has(runId)) fail(`run ${runId} backs more than one catalogue date`);
    runIds.add(runId);

    // Re-derived, not trusted: the key is a pure function of the date and run,
    // so a document where they disagree is malformed rather than ambiguous.
    const manifest = requireString(entry.manifest, `dates[${index}].manifest`, 64);
    const expected = `asof-${asOfDate}-${runId}.json`;
    if (manifest !== expected) {
      fail(`dates[${index}].manifest is ${manifest}, expected ${expected}`);
    }

    times.push(time);
    return {
      asOfDate,
      runId,
      manifest,
      manifestUrl: resolveTrustedManifest(manifest, `dates[${index}].manifest`, base).href,
    };
  });

  if (times.some((time, index) => index > 0 && time >= times[index - 1])) {
    fail("catalogue dates must be unique and newest first");
  }
  if (times.length > 0 && (times[0] - times[times.length - 1]) / MILLISECONDS_PER_DAY >= maxDates) {
    fail(`catalogue spans more than its retention window of ${maxDates} days`);
  }

  return { schemaVersion: CATALOGUE_SCHEMA_VERSION, kind: CATALOGUE_KIND, generatedAt, maxDates, dates };
}
