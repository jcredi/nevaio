/**
 * Runtime validation for the snow metadata the browser fetches (audit F6).
 *
 * The manifest and the fallback sidecar are network JSON. TypeScript types
 * describe what we hope to receive; they check nothing at runtime, so a
 * poisoned or corrupted manifest could previously choose which hosts the
 * browser fetched rasters from. These functions are the actual gate, and they
 * are pure so they can be tested without a browser or a map.
 *
 * The trust anchor is the manifest URL itself, which comes from build-time
 * configuration rather than from the network: every tile URL must resolve to
 * the same origin and directory as the manifest that offered it. That way a
 * manifest can never point the browser somewhere new, and no separate host
 * allowlist has to be kept in sync with deployment. The deployed CSP in
 * app/public/_headers is the independent second layer.
 */

/** Sidecar written by pipeline/tools/make_sample_overlay.py alongside the fallback PNG. */
export type SnowImageMeta = {
  image: string;
  product: string;
  tile: string;
  date: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  bounds: [number, number, number, number];
};

/** AS-OF snapshot manifest published atomically by nevaio_pipeline.render. */
export type SnowTileManifest = {
  schemaVersion: number;
  runId: string;
  mode: "asof-window";
  asOfDate: string;
  /** Product dates composed per spec section 9.2; 31 covers its 30-day ceiling. */
  asOfWindowDays?: number;
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  sourceTileCount: number;
  requestedSourceTileCount?: number;
  missingSourceTiles?: string[];
  sourceProductTotal?: number;
  tileCount: number;
  notice: string;
};

/** A validated manifest, with its tile templates already resolved to URLs. */
export type ValidatedManifest = {
  manifest: SnowTileManifest;
  tileUrls: string[];
};

export const SCHEMA_VERSION = 1;

// Bounds generous enough for any plausible publication, tight enough that a
// malformed document cannot turn into thousands of requests or a giant string.
const LIMITS = {
  maxTileTemplates: 4,
  maxUrlLength: 512,
  maxNoticeLength: 2000,
  maxRunIdLength: 32,
  maxZoom: 22,
  maxTileCount: 1_000_000,
  maxSourceTileCount: 10_000,
  maxWindowDays: 366,
};

// {z}/{x}/{y} are not legal URL characters, so tile templates are parked into
// placeholders while the URL is parsed and restored once it has been checked.
const PARKED: ReadonlyArray<readonly [string, string]> = [
  ["{z}", "_XYZ_Z_"],
  ["{x}", "_XYZ_X_"],
  ["{y}", "_XYZ_Y_"],
];

function park(value: string): string {
  return PARKED.reduce((acc, [token, placeholder]) => acc.replaceAll(token, placeholder), value);
}

function unpark(value: string): string {
  return PARKED.reduce((acc, [token, placeholder]) => acc.replaceAll(placeholder, token), value);
}

const RUN_ID = /^\d{8}T\d{6}Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TILE_PATH_SUFFIX = "/tiles/{z}/{x}/{y}.png";

export class ManifestError extends Error {}

function fail(message: string): never {
  throw new ManifestError(message);
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

/** west, south, east, north in degrees, ordered and inside the real world. */
function requireBounds(value: unknown, field: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    fail(`${field} must be four numbers`);
  }
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    fail(`${field} must contain only finite numbers`);
  }
  const [west, south, east, north] = value as [number, number, number, number];
  if (west < -180 || east > 180 || west >= east) {
    fail(`${field} longitudes are not an ordered pair inside [-180, 180]`);
  }
  if (south < -90 || north > 90 || south >= north) {
    fail(`${field} latitudes are not an ordered pair inside [-90, 90]`);
  }
  return [west, south, east, north];
}

/**
 * Resolve one URL from network JSON against a trusted base, refusing anything
 * that changes where the browser would send the request.
 */
function resolveTrustedUrl(
  candidate: unknown,
  field: string,
  base: URL,
  { expectedPath }: { expectedPath?: string } = {},
): URL {
  const raw = requireString(candidate, field, LIMITS.maxUrlLength);
  let resolved: URL;
  try {
    resolved = new URL(park(raw), base);
  } catch {
    return fail(`${field} is not a resolvable URL`);
  }
  if (resolved.origin !== base.origin) {
    fail(`${field} points at ${resolved.origin}, not the manifest's own ${base.origin}`);
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
  if (expectedPath !== undefined && unpark(resolved.pathname) !== expectedPath) {
    fail(`${field} path is ${unpark(resolved.pathname)}, expected ${expectedPath}`);
  }
  return resolved;
}

/** The directory the manifest itself lives in, which its assets must share. */
function directoryOf(base: URL): string {
  return base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
}

/**
 * Validate a tile manifest and resolve its tile URL templates.
 *
 * `manifestUrl` is the trusted, build-time-configured location the document
 * came from; `pageUrl` resolves it if it is itself relative.
 */
export function validateTileManifest(
  document: unknown,
  manifestUrl: string,
  pageUrl: string,
): ValidatedManifest {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    fail("manifest must be a JSON object");
  }
  const source = document as Record<string, unknown>;

  if (source.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported manifest schemaVersion ${String(source.schemaVersion)}`);
  }
  if (source.mode !== "asof-window") {
    fail(`unsupported manifest mode ${String(source.mode)}`);
  }

  const runId = requireString(source.runId, "runId", LIMITS.maxRunIdLength);
  if (!RUN_ID.test(runId)) fail(`runId is not a UTC run identifier: ${runId}`);
  const asOfDate = requireString(source.asOfDate, "asOfDate", 10);
  if (!ISO_DATE.test(asOfDate)) fail(`asOfDate is not an ISO date: ${asOfDate}`);

  const minzoom = requireInteger(source.minzoom, "minzoom", 0, LIMITS.maxZoom);
  const maxzoom = requireInteger(source.maxzoom, "maxzoom", 0, LIMITS.maxZoom);
  if (minzoom > maxzoom) fail(`minzoom ${minzoom} is above maxzoom ${maxzoom}`);

  const bounds = requireBounds(source.bounds, "bounds");
  const tileCount = requireInteger(source.tileCount, "tileCount", 0, LIMITS.maxTileCount);
  const sourceTileCount = requireInteger(
    source.sourceTileCount,
    "sourceTileCount",
    0,
    LIMITS.maxSourceTileCount,
  );
  const notice = requireString(source.notice, "notice", LIMITS.maxNoticeLength);

  let requestedSourceTileCount: number | undefined;
  if (source.requestedSourceTileCount !== undefined) {
    requestedSourceTileCount = requireInteger(
      source.requestedSourceTileCount,
      "requestedSourceTileCount",
      0,
      LIMITS.maxSourceTileCount,
    );
    if (sourceTileCount > requestedSourceTileCount) {
      fail(
        `sourceTileCount ${sourceTileCount} exceeds requestedSourceTileCount ` +
          `${requestedSourceTileCount}`,
      );
    }
  }
  let asOfWindowDays: number | undefined;
  if (source.asOfWindowDays !== undefined) {
    asOfWindowDays = requireInteger(
      source.asOfWindowDays,
      "asOfWindowDays",
      1,
      LIMITS.maxWindowDays,
    );
  }

  if (!Array.isArray(source.tiles) || source.tiles.length === 0) {
    fail("tiles must be a non-empty array");
  }
  if (source.tiles.length > LIMITS.maxTileTemplates) {
    fail(`tiles has ${source.tiles.length} templates, over the ${LIMITS.maxTileTemplates} limit`);
  }

  const base = new URL(manifestUrl, pageUrl);
  // A run's tiles live beside its own manifest, under runs/<runId>/tiles/.
  const expectedPath = `${directoryOf(base)}runs/${runId}${TILE_PATH_SUFFIX}`;
  const tileUrls = source.tiles.map((template, index) =>
    unpark(resolveTrustedUrl(template, `tiles[${index}]`, base, { expectedPath }).href),
  );

  const manifest: SnowTileManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    mode: "asof-window",
    asOfDate,
    asOfWindowDays,
    tiles: source.tiles as string[],
    minzoom,
    maxzoom,
    bounds,
    sourceTileCount,
    requestedSourceTileCount,
    tileCount,
    notice,
  };
  return { manifest, tileUrls };
}

/** A validated fallback sidecar, with its image URL already resolved. */
export type ValidatedImageMeta = {
  meta: SnowImageMeta;
  imageUrl: string;
};

export function validateImageMeta(
  document: unknown,
  sidecarUrl: string,
  pageUrl: string,
): ValidatedImageMeta {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    fail("sidecar must be a JSON object");
  }
  const source = document as Record<string, unknown>;

  const base = new URL(sidecarUrl, pageUrl);
  const image = resolveTrustedUrl(source.image, "image", base);
  if (!image.pathname.endsWith(".png")) fail(`image is not a PNG: ${image.pathname}`);

  const product = requireString(source.product, "product", 128);
  const tile = requireString(source.tile, "tile", 16);
  const date = requireString(source.date, "date", 10);
  if (!ISO_DATE.test(date)) fail(`date is not an ISO date: ${date}`);
  const bounds = requireBounds(source.bounds, "bounds");

  if (!Array.isArray(source.coordinates) || source.coordinates.length !== 4) {
    fail("coordinates must be four corner pairs");
  }
  const coordinates = source.coordinates.map((corner, index) => {
    if (!Array.isArray(corner) || corner.length !== 2) {
      fail(`coordinates[${index}] must be a [lon, lat] pair`);
    }
    const [lon, lat] = corner as [unknown, unknown];
    if (typeof lon !== "number" || typeof lat !== "number") {
      fail(`coordinates[${index}] must be numbers`);
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      fail(`coordinates[${index}] must be finite`);
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      fail(`coordinates[${index}] is outside the real world`);
    }
    return [lon, lat] as [number, number];
  }) as SnowImageMeta["coordinates"];

  return {
    meta: { image: source.image as string, product, tile, date, coordinates, bounds },
    imageUrl: image.href,
  };
}
