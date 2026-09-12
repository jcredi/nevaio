/**
 * Runtime validation for the static, sharded OSM object index
 * (spec amendment v1.11).
 *
 * This is the app's identity contract for the object panel and, later, the
 * per-object snow history. It is deliberately *not* the MapTiler basemap:
 * `docs/research/maptiler-outdoor-objects.md` records what a rendered
 * provider-tile feature really is - no saddles at all, ~25% of peaks, a
 * visible subset that changes with zoom and label collision, an undocumented
 * id encoding that differs per source layer, and at least one feature whose
 * OSM node is already deleted upstream. None of that can anchor a history
 * lookup, so none of it is read here.
 *
 * Two documents, mirroring what the pipeline publishes. The entry point lists
 * 54 shards (211,865 objects total; the single file was 39 MB):
 *
 *     { "schemaVersion": 1, "objectCount": 211865,
 *       "shards": [ { "tile": "31TFK", "path": "objects/31TFK.json",
 *                     "bounds": [west, south, east, north],
 *                     "objectCount": 2742, "bytes": 370495,
 *                     "sha256": "c5c6..." } ] }
 *
 * and each shard holds the records:
 *
 *     { "schemaVersion": 1, "tile": "31TFK",
 *       "objects": [ { "id": "node/123", "kind": "peak", "name": "...",
 *                      "longitude": 7.8, "latitude": 45.9,
 *                      "elevationMeters": 4554 } ] }
 *
 * Written in the same spirit as `../snow/manifestSchema.ts`: these arrive over
 * the network, TypeScript types check nothing at runtime, so this is the
 * actual gate. In particular each shard `path` is resolved against the index's
 * own URL and must stay on that origin and in that directory, so a poisoned
 * index cannot redirect the browser somewhere new - the same trust anchor the
 * snow manifest uses. This module imports nothing, so `npm test` runs it
 * directly under Node.
 */

/** The six selectable classes frozen by spec amendment v1.10. */
export const OBJECT_KINDS = [
  "peak",
  "hut",
  "saddle",
  "shelter",
  "parking",
  "settlement",
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** One selectable object. `id` is the durable `<osmType>/<osmId>` identity. */
export type ObjectRecord = {
  id: string;
  kind: ObjectKind;
  name: string;
  longitude: number;
  latitude: number;
  /** Metres, or null where OSM has no usable `ele` tag - frequently null. */
  elevationMeters: number | null;
};

/** west, south, east, north, in degrees. */
export type Bounds = [number, number, number, number];

/** One shard, as listed by the entry-point document. */
export type ShardDescriptor = {
  tile: string;
  /** Already resolved against the index URL and checked. */
  url: string;
  /** What the shard's objects actually span, not the MGRS granule. */
  bounds: Bounds;
  objectCount: number;
  bytes: number;
  sha256: string;
};

export type ShardIndex = {
  schemaVersion: number;
  objectCount: number;
  shards: ShardDescriptor[];
};

export type ObjectShard = {
  schemaVersion: number;
  tile: string;
  objects: ObjectRecord[];
};

export const OBJECT_INDEX_SCHEMA_VERSION = 1;

// Bounds generous enough for any plausible publication, tight enough that a
// malformed or hostile document cannot exhaust memory or the DOM. Today's
// real figures: 54 shards, largest 10,662 objects / 1,461,755 bytes.
const LIMITS = {
  maxShards: 500,
  maxObjectsPerShard: 100_000,
  maxTotalObjects: 5_000_000,
  maxShardBytes: 16 * 1024 * 1024,
  maxUrlLength: 512,
  maxIdLength: 32,
  maxNameLength: 200,
  minElevationMeters: -500,
  maxElevationMeters: 9000,
};

const OBJECT_ID = /^(node|way|relation)\/[1-9]\d{0,18}$/;
/** MGRS 100 km square designator, e.g. 31TFK or 5QKB. */
const MGRS_TILE = /^[0-9]{1,2}[A-Z]{3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS: ReadonlySet<string> = new Set(OBJECT_KINDS);

export class ObjectIndexError extends Error {}

function fail(message: string): never {
  throw new ObjectIndexError(message);
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.length === 0) fail(`${field} must not be empty`);
  if (value.length > maxLength) {
    fail(`${field} is ${value.length} characters, over the ${maxLength} limit`);
  }
  return value;
}

function requireFinite(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  if (value < min || value > max) fail(`${field} must be between ${min} and ${max}`);
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
function requireBounds(value: unknown, field: string): Bounds {
  if (!Array.isArray(value) || value.length !== 4) fail(`${field} must be four numbers`);
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    fail(`${field} must contain only finite numbers`);
  }
  const [west, south, east, north] = value as Bounds;
  if (west < -180 || east > 180 || west >= east) {
    fail(`${field} longitudes are not an ordered pair inside [-180, 180]`);
  }
  if (south < -90 || north > 90 || south >= north) {
    fail(`${field} latitudes are not an ordered pair inside [-90, 90]`);
  }
  return [west, south, east, north];
}

/** The directory the index itself lives in, which its shards must share. */
function directoryOf(base: URL): string {
  return base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
}

/**
 * Resolve one shard path against the trusted index URL, refusing anything
 * that changes where the browser would send the request.
 *
 * Identical in intent to `manifestSchema.ts`'s tile-URL rule: the trust anchor
 * is the index URL, which comes from build-time configuration rather than from
 * the network, and nothing the network says may move a request off it.
 */
function resolveShardUrl(candidate: unknown, field: string, base: URL): string {
  const raw = requireString(candidate, field, LIMITS.maxUrlLength);
  let resolved: URL;
  try {
    resolved = new URL(raw, base);
  } catch {
    return fail(`${field} is not a resolvable URL`);
  }
  if (resolved.origin !== base.origin) {
    fail(`${field} points at ${resolved.origin}, not the index's own ${base.origin}`);
  }
  if (resolved.protocol !== base.protocol) {
    fail(`${field} changes the scheme to ${resolved.protocol}`);
  }
  if (resolved.username || resolved.password) fail(`${field} must not embed credentials`);
  if (resolved.search || resolved.hash) {
    fail(`${field} must not carry a query string or fragment`);
  }
  if (!resolved.pathname.startsWith(directoryOf(base))) {
    fail(`${field} escapes the index directory: ${resolved.pathname}`);
  }
  return resolved.href;
}

function validateRecord(value: unknown, field: string): ObjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} must be a JSON object`);
  }
  const source = value as Record<string, unknown>;

  const id = requireString(source.id, `${field}.id`, LIMITS.maxIdLength);
  if (!OBJECT_ID.test(id)) fail(`${field}.id is not an <osmType>/<osmId> identity: ${id}`);

  const kind = requireString(source.kind, `${field}.kind`, 16);
  if (!KINDS.has(kind)) fail(`${field}.kind is not a selectable class: ${kind}`);

  // The name is written straight into the panel. Length is bounded here; the
  // panel itself uses textContent, never innerHTML, so there is no markup sink.
  const name = requireString(source.name, `${field}.name`, LIMITS.maxNameLength);

  const longitude = requireFinite(source.longitude, `${field}.longitude`, -180, 180);
  const latitude = requireFinite(source.latitude, `${field}.latitude`, -90, 90);

  // `elevationMeters` is null far more often than not; that is the contract,
  // not a defect, and the panel omits the line rather than printing "null m".
  let elevationMeters: number | null = null;
  if (source.elevationMeters !== null && source.elevationMeters !== undefined) {
    elevationMeters = requireFinite(
      source.elevationMeters,
      `${field}.elevationMeters`,
      LIMITS.minElevationMeters,
      LIMITS.maxElevationMeters,
    );
  }

  return { id, kind: kind as ObjectKind, name, longitude, latitude, elevationMeters };
}

function requireDocument(document: unknown, what: string): Record<string, unknown> {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    fail(`${what} must be a JSON object`);
  }
  const source = document as Record<string, unknown>;
  if (source.schemaVersion !== OBJECT_INDEX_SCHEMA_VERSION) {
    fail(`unsupported ${what} schemaVersion ${String(source.schemaVersion)}`);
  }
  return source;
}

/**
 * Validate the entry-point document and resolve each shard's URL.
 *
 * `indexUrl` is the trusted, build-time-configured location the document came
 * from; `pageUrl` resolves it if it is itself relative.
 */
export function validateShardIndex(
  document: unknown,
  indexUrl: string,
  pageUrl: string,
): ShardIndex {
  const source = requireDocument(document, "object index");

  const objectCount = requireInteger(
    source.objectCount,
    "objectCount",
    0,
    LIMITS.maxTotalObjects,
  );
  if (!Array.isArray(source.shards)) fail("shards must be an array");
  if (source.shards.length > LIMITS.maxShards) {
    fail(`shards has ${source.shards.length} entries, over the ${LIMITS.maxShards} limit`);
  }

  const base = new URL(indexUrl, pageUrl);
  const shards: ShardDescriptor[] = [];
  const seenTiles = new Set<string>();
  let listedObjects = 0;

  for (const [index, entry] of source.shards.entries()) {
    const field = `shards[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(`${field} must be a JSON object`);
    }
    const shard = entry as Record<string, unknown>;

    const tile = requireString(shard.tile, `${field}.tile`, 8);
    if (!MGRS_TILE.test(tile)) fail(`${field}.tile is not an MGRS square: ${tile}`);
    // A repeated tile would make shard caching ambiguous and is a build bug.
    if (seenTiles.has(tile)) fail(`duplicate shard tile ${tile}`);
    seenTiles.add(tile);

    const url = resolveShardUrl(shard.path, `${field}.path`, base);
    // Shard bounds legitimately overlap at UTM zone seams (Mont Blanc is in
    // both 31TGL and 32TLR), so overlap is not checked - only that each is a
    // real box.
    const bounds = requireBounds(shard.bounds, `${field}.bounds`);
    const shardObjectCount = requireInteger(
      shard.objectCount,
      `${field}.objectCount`,
      0,
      LIMITS.maxObjectsPerShard,
    );
    const bytes = requireInteger(shard.bytes, `${field}.bytes`, 0, LIMITS.maxShardBytes);
    const sha256 = requireString(shard.sha256, `${field}.sha256`, 64);
    if (!SHA256.test(sha256)) fail(`${field}.sha256 is not a lowercase hex digest`);

    listedObjects += shardObjectCount;
    shards.push({ tile, url, bounds, objectCount: shardObjectCount, bytes, sha256 });
  }

  // Every object lives in exactly one shard, so the totals must agree. A
  // mismatch means the index and the shards were not built together.
  if (listedObjects !== objectCount) {
    fail(`shards list ${listedObjects} objects but objectCount is ${objectCount}`);
  }

  return { schemaVersion: OBJECT_INDEX_SCHEMA_VERSION, objectCount, shards };
}

/**
 * Validate one shard document.
 *
 * Rejects the whole shard rather than skipping bad records: a partially
 * accepted shard would silently drop selectable objects, and "the peak you
 * tapped is not in the index" must mean the index says so, not that a
 * validator quietly discarded it.
 */
export function validateObjectShard(document: unknown, expected: ShardDescriptor): ObjectShard {
  const source = requireDocument(document, "object shard");

  const tile = requireString(source.tile, "tile", 8);
  if (tile !== expected.tile) {
    fail(`shard says it is ${tile} but was fetched as ${expected.tile}`);
  }
  if (!Array.isArray(source.objects)) fail("objects must be an array");
  if (source.objects.length !== expected.objectCount) {
    fail(
      `shard ${tile} holds ${source.objects.length} objects, ` +
        `but the index promised ${expected.objectCount}`,
    );
  }

  const objects: ObjectRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of source.objects.entries()) {
    const record = validateRecord(entry, `objects[${index}]`);
    // Ids are globally unique by construction; a duplicate inside one shard
    // would make a selection ambiguous for no good reason.
    if (seen.has(record.id)) fail(`duplicate object id ${record.id} in shard ${tile}`);
    seen.add(record.id);
    objects.push(record);
  }

  return { schemaVersion: OBJECT_INDEX_SCHEMA_VERSION, tile, objects };
}

/** Do two [west, south, east, north] boxes overlap at all? */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** The shards whose own object extent overlaps the given box. */
export function shardsFor(index: ShardIndex, viewport: Bounds): ShardDescriptor[] {
  return index.shards.filter((shard) => boundsIntersect(shard.bounds, viewport));
}
