/**
 * Runtime validation for the static OSM object index (spec amendment v1.11).
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
 * The document mirrors `nevaio_pipeline.object_index.build_index_document`
 * byte for byte:
 *
 *     { "schemaVersion": 1,
 *       "objects": [ { "id": "node/123", "kind": "peak", "name": "...",
 *                      "longitude": 7.8, "latitude": 45.9,
 *                      "elevationMeters": 4554 } ] }
 *
 * Written in the same spirit as `../map/manifestSchema.ts`: the index arrives
 * over the network, TypeScript types check nothing at runtime, so this is the
 * actual gate. It imports nothing - no config, no `import.meta.env`, no
 * MapLibre - so `npm test` runs it directly under Node.
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
  /** Metres, or null where OSM has no usable `ele` tag. */
  elevationMeters: number | null;
};

export type ObjectIndex = {
  schemaVersion: number;
  objects: ObjectRecord[];
};

export const OBJECT_INDEX_SCHEMA_VERSION = 1;

// Bounds generous enough for any plausible published shard, tight enough that
// a malformed or hostile document cannot exhaust memory or the DOM. The real
// Alps+Italy build is 244,011 records (worklog 2026-09-11) and is explicitly
// *not* shippable as one download, so a shard far above this ceiling is a
// pipeline bug, not something to render.
const LIMITS = {
  maxObjects: 50_000,
  maxIdLength: 32,
  maxNameLength: 200,
  minElevationMeters: -500,
  maxElevationMeters: 9000,
};

const OBJECT_ID = /^(node|way|relation)\/[1-9]\d{0,18}$/;
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

/**
 * Validate a fetched object-index document.
 *
 * Rejects the whole document rather than skipping bad records: a partially
 * accepted index would silently drop selectable objects, and "the peak you
 * tapped is not in the index" must mean the index says so, not that a
 * validator quietly discarded it.
 */
export function validateObjectIndex(document: unknown): ObjectIndex {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    fail("object index must be a JSON object");
  }
  const source = document as Record<string, unknown>;

  if (source.schemaVersion !== OBJECT_INDEX_SCHEMA_VERSION) {
    fail(`unsupported object index schemaVersion ${String(source.schemaVersion)}`);
  }
  if (!Array.isArray(source.objects)) fail("objects must be an array");
  if (source.objects.length > LIMITS.maxObjects) {
    fail(`objects has ${source.objects.length} entries, over the ${LIMITS.maxObjects} limit`);
  }

  const objects: ObjectRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of source.objects.entries()) {
    const record = validateRecord(entry, `objects[${index}]`);
    // Duplicates would make a selection ambiguous for no good reason, and the
    // pipeline core already refuses them; a duplicate here means the shard was
    // assembled wrongly.
    if (seen.has(record.id)) fail(`duplicate object id ${record.id}`);
    seen.add(record.id);
    objects.push(record);
  }

  return { schemaVersion: OBJECT_INDEX_SCHEMA_VERSION, objects };
}
