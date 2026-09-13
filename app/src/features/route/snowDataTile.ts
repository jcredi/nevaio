/**
 * Decoding for the snow *data* tile pyramid (spec section 8.4), the lossless
 * counterpart to the visual snow raster.
 *
 * **Why this exists rather than reading the tiles the map already shows**: the
 * visual raster deliberately cannot answer the question a route profile asks.
 * Spec section 5.4 says so outright - "A valid 0% pixel is *not*
 * distinguishable from these on the map raster (both are fully transparent)" -
 * so reading it back would lose the difference between *no snow* and *no
 * observation*, which for a route is the entire question, and would lose the
 * QA tier that spec section 15 item 11 requires. The alternatives and the
 * measured storage cost are in `docs/research/snow-along-route.md`.
 *
 * **This file is one half of a contract.** The other half is
 * `pipeline/src/nevaio_pipeline/data_tiles.py`, and the two must change
 * together:
 *
 *   R  GF value 0-100, or 255 (`NO_VALUE`) where the state is not valid
 *   G  observation age in days 0-30, or 255 (`AGE_NOT_APPLICABLE`)
 *   B  bits 0-1: QA tier 0-3.  bits 2-4: state (see `SnowDataState`)
 *   A  always 255
 *
 * **Alpha carries no data, and the reason is this decoder's problem more than
 * the encoder's.** Canvas `getImageData` returns colour channels that were
 * premultiplied by alpha and then un-premultiplied, so at any alpha below 255
 * the other three channels come back rounded - silently, with no error. A
 * format that used alpha as a fourth field would yield snow percentages that
 * are quietly wrong. `decodePixel` therefore treats a non-opaque pixel as
 * unreadable rather than trusting it.
 *
 * Pure: no `fetch`, no DOM, no config, so `npm test` runs it under Node. The
 * loading half lives in `snowDataClient.ts`, mirroring how `seriesFormat.ts`
 * and `seriesClient.ts` split the same way.
 */

/**
 * Mirrors `DataState` in `data_tiles.py`.
 *
 * A frozen const object rather than a TypeScript `enum`, deliberately: `npm
 * test` runs these files directly under Node's type stripping, which only
 * accepts *erasable* syntax. An `enum` emits real runtime code and fails to
 * load with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Every other module here uses
 * the same `as const` shape for the same reason - keep it.
 */
export const SnowDataState = {
  Valid: 0,
  Cloud: 1,
  Water: 2,
  NoData: 3,
  Stale: 4,
} as const;

export type SnowDataState = (typeof SnowDataState)[keyof typeof SnowDataState];

export const NO_VALUE = 255;
export const AGE_NOT_APPLICABLE = 255;
export const MAX_AGE_DAYS = 30;
export const ALPHA_OPAQUE = 255;

/** The zoom the data pyramid is published at - native GFSC resolution. */
export const DATA_TILE_ZOOM = 11;
export const DATA_TILE_SIZE = 256;

export type SnowDataCell = {
  /** Snow-cover percentage, or null where the state is not `Valid`. */
  fsc: number | null;
  /** Observation age in days, or null where none applies. */
  ageDays: number | null;
  /** GF-QA tier 0-3, meaningful only where the state is `Valid`. */
  quality: number | null;
  state: SnowDataState;
};

/** What an unreadable or out-of-bounds sample is, so nothing has to invent one. */
export const UNKNOWN_CELL: SnowDataCell = {
  fsc: null,
  ageDays: null,
  quality: null,
  state: SnowDataState.NoData,
};

function stateFromCode(code: number): SnowDataState {
  switch (code) {
    case 0:
      return SnowDataState.Valid;
    case 1:
      return SnowDataState.Cloud;
    case 2:
      return SnowDataState.Water;
    case 4:
      return SnowDataState.Stale;
    default:
      // Includes 3 (no data) and anything the encoder never emits. An unknown
      // code is reported as no data, never guessed at and never treated as a
      // reading.
      return SnowDataState.NoData;
  }
}

/**
 * Decode one RGBA pixel.
 *
 * A pixel whose alpha is not exactly opaque is rejected as unknown: see the
 * module docstring. That is not defensive tidiness - it is the difference
 * between a correct percentage and a rounded one.
 */
export function decodePixel(red: number, green: number, blue: number, alpha: number): SnowDataCell {
  if (alpha !== ALPHA_OPAQUE) return UNKNOWN_CELL;

  const state = stateFromCode((blue >> 2) & 0b111);
  const isValid = state === SnowDataState.Valid;
  return {
    // A percentage only where the state says there is one. A stale pixel's raw
    // value is deliberately not published, and a value outside 0-100 is not a
    // percentage whatever the state claims.
    fsc: isValid && red <= 100 ? red : null,
    ageDays: green <= MAX_AGE_DAYS ? green : null,
    quality: isValid ? blue & 0b11 : null,
    state,
  };
}

/** Decode the pixel at `(x, y)` within a `DATA_TILE_SIZE` square RGBA buffer. */
export function decodeAt(pixels: Uint8ClampedArray | Uint8Array, x: number, y: number): SnowDataCell {
  if (x < 0 || y < 0 || x >= DATA_TILE_SIZE || y >= DATA_TILE_SIZE) return UNKNOWN_CELL;
  const offset = (y * DATA_TILE_SIZE + x) * 4;
  if (offset + 3 >= pixels.length) return UNKNOWN_CELL;
  return decodePixel(pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]);
}

export type TileAddress = { z: number; x: number; y: number };
export type PixelAddress = TileAddress & { px: number; py: number };

/**
 * Which data tile, and which pixel inside it, a coordinate falls in.
 *
 * Standard slippy-map arithmetic
 * (https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames), matching
 * `_tile_transform` in `tiles.py`. Latitudes beyond Web Mercator's limits are
 * clamped rather than producing a NaN tile index; nothing in this app's
 * footprint is near them, but a clamped answer is debuggable and a NaN is not.
 */
export function pixelAddressFor(longitude: number, latitude: number, z: number = DATA_TILE_ZOOM): PixelAddress {
  const n = 2 ** z;
  const clampedLat = Math.min(85.05112878, Math.max(-85.05112878, latitude));
  const latRad = (clampedLat * Math.PI) / 180;

  const worldX = ((longitude + 180) / 360) * n;
  const worldY = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;

  const x = Math.floor(worldX);
  const y = Math.floor(worldY);
  return {
    z,
    x,
    y,
    px: Math.min(DATA_TILE_SIZE - 1, Math.floor((worldX - x) * DATA_TILE_SIZE)),
    py: Math.min(DATA_TILE_SIZE - 1, Math.floor((worldY - y) * DATA_TILE_SIZE)),
  };
}

/** Human-facing name for a state, for the profile's freshness/quality readout. */
export const STATE_LABELS: Record<SnowDataState, string> = {
  [SnowDataState.Valid]: "Observed",
  [SnowDataState.Cloud]: "Cloud",
  [SnowDataState.Water]: "Water",
  [SnowDataState.NoData]: "No data",
  [SnowDataState.Stale]: "Stale",
};

/**
 * Quality tier names, matching `QUALITY_TIER_LABELS` in
 * `../objects/seriesFormat.ts`. Spec section 5.4 requires the tier to be
 * displayed **by name**, and section 15 item 11 requires it prominently on the
 * route profile - so this is not decoration.
 */
export const QUALITY_LABELS = ["High", "Medium", "Low", "Minimal"] as const;
