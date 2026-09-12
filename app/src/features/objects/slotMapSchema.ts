/**
 * Runtime validation for one tile's permanent object slot map
 * (`slots/<TILE>.json`), published beside the object index (`docs/plan.md`
 * item 1; `pipeline/src/nevaio_pipeline/object_slots.py` is the producing
 * side and the authority on the document shape:
 *
 *     { "schemaVersion": 1, "tile": "31TFK", "slotCount": 2742,
 *       "slotIds": ["node/123", "way/456", ...] }
 *
 * `slotIds[i]` is the OSM id permanently occupying row `i` of every
 * `series/<TILE>/<YYYY-MM>.bin` month file for that tile - see
 * `seriesFormat.ts` for the byte layout that row indexes into.
 *
 * This is the fourth network-facing document the app validates before use,
 * alongside `features/snow/manifestSchema.ts`,
 * `features/snow/dateCatalogueSchema.ts` and `objectIndexSchema.ts` in this
 * same folder. Like those three, it keeps its own copies of the primitive
 * checks rather than importing them: each one reads and audits end to end on
 * its own, and that is worth more here than removing a dozen lines.
 *
 * There is no URL to resolve inside this document (unlike the shard index,
 * a slot map names no other resource), so the trust surface is narrower: bound
 * the array, bound each id's shape, and confirm the document claims the tile
 * the caller actually asked for - a slot map for the wrong tile would silently
 * mis-key every Range read built from it.
 *
 * This module imports nothing, so `npm test` runs it directly under Node.
 */

export type SlotMap = {
  schemaVersion: number;
  tile: string;
  slotCount: number;
  /** `slotIds[i]` is the `<osmType>/<osmId>` identity permanently in slot `i`. */
  slotIds: readonly string[];
};

export const SLOT_MAP_SCHEMA_VERSION = 1;

// A slot map covers one MGRS tile; today's largest object shard is ~10,700
// records (docs research, 2026-09-11), so this is generous headroom, not a
// measured ceiling - tuned to stop a hostile or corrupted document from
// exhausting memory, not to reject a real one.
const LIMITS = {
  maxSlotCount: 500_000,
  maxIdLength: 32,
};

const OBJECT_ID = /^(node|way|relation)\/[1-9]\d{0,18}$/;
/** MGRS 100 km square designator, e.g. 31TFK or 5QKB. */
const MGRS_TILE = /^[0-9]{1,2}[A-Z]{3}$/;

export class SlotMapError extends Error {}

function fail(message: string): never {
  throw new SlotMapError(message);
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

/**
 * Validate one tile's slot map. `expectedTile` is the tile the caller fetched
 * this document *as* (from the object index it already trusts), and the
 * document must agree - the same cross-check `objectIndexSchema.ts` runs
 * between a shard's own `tile` field and the one it was requested as.
 */
export function validateSlotMap(document: unknown, expectedTile: string): SlotMap {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    fail("slot map must be a JSON object");
  }
  const source = document as Record<string, unknown>;
  if (source.schemaVersion !== SLOT_MAP_SCHEMA_VERSION) {
    fail(`unsupported slot map schemaVersion ${String(source.schemaVersion)}`);
  }

  const tile = requireString(source.tile, "tile", 8);
  if (!MGRS_TILE.test(tile)) fail(`tile is not an MGRS square: ${tile}`);
  if (tile !== expectedTile) {
    fail(`slot map says it is ${tile} but was fetched as ${expectedTile}`);
  }

  if (!Array.isArray(source.slotIds)) fail("slotIds must be an array");
  if (source.slotIds.length > LIMITS.maxSlotCount) {
    fail(`slotIds has ${source.slotIds.length} entries, over the ${LIMITS.maxSlotCount} limit`);
  }

  const slotIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of source.slotIds.entries()) {
    const id = requireString(entry, `slotIds[${index}]`, LIMITS.maxIdLength);
    if (!OBJECT_ID.test(id)) fail(`slotIds[${index}] is not an <osmType>/<osmId> identity: ${id}`);
    // The slot map's whole job is a 1:1 id<->row mapping; a duplicate would
    // make "the slot for this id" ambiguous.
    if (seen.has(id)) fail(`duplicate object id ${id} in slot map for ${tile}`);
    seen.add(id);
    slotIds.push(id);
  }

  const slotCount = requireInteger(source.slotCount, "slotCount", 0, LIMITS.maxSlotCount);
  if (slotCount !== slotIds.length) {
    fail(`slotCount is ${slotCount} but slotIds holds ${slotIds.length} entries`);
  }

  return { schemaVersion: SLOT_MAP_SCHEMA_VERSION, tile, slotCount, slotIds };
}

/** The permanent slot for `objectId`, or `null` if this tile has never assigned it one. */
export function slotFor(slotMap: SlotMap, objectId: string): number | null {
  const index = slotMap.slotIds.indexOf(objectId);
  return index === -1 ? null : index;
}
