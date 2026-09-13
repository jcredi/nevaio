/**
 * Loads snow data tiles and samples them (spec section 8.4).
 *
 * The loading half of `snowDataTile.ts`, split the same way `seriesClient.ts`
 * splits from `seriesFormat.ts`: everything provider- and browser-specific is
 * here, so the decoding stays pure and Node-testable.
 *
 * **The tile URL comes from the snow manifest**, never from configuration:
 * `validateTileManifest` resolves it and holds it to the same origin and
 * run-directory rules as the visual tiles, so `VITE_SNOW_MANIFEST_URL` remains
 * the single trust anchor for the whole snow layer. A run that publishes no
 * data pyramid simply yields no sampler, and the route panel says snow is
 * unavailable - it never falls back to the visual tiles, which cannot answer
 * the question (spec section 5.4).
 *
 * **Why an `<img>` and a canvas rather than `fetch`**: decoding a PNG by hand
 * is not something this app should do, and the browser already has a decoder.
 * The cost is that the image must be CORS-readable or the canvas is tainted and
 * `getImageData` throws - hence `crossOrigin = "anonymous"`. The R2 bucket
 * already sends permissive CORS for the visual tiles, so this is the same
 * arrangement, but if data tiles ever 403 or the canvas taints, that is the
 * first thing to check.
 *
 * Every failure here is reported as *unknown*, never as "no snow". A tile that
 * will not load tells us nothing about the ground, and spec section 5.4's whole
 * point is that those two are different answers.
 */
import {
  DATA_TILE_SIZE,
  UNKNOWN_CELL,
  decodeAt,
  pixelAddressFor,
  type SnowDataCell,
} from "./snowDataTile.ts";

/** Bound how many tiles one route may pull; a 100 km route crosses only a handful. */
const MAX_TILES_PER_ROUTE = 24;

/** Give up on a tile rather than leaving the profile spinning forever. */
const TILE_TIMEOUT_MS = 10_000;

type TileKey = string;

function keyFor(z: number, x: number, y: number): TileKey {
  return `${z}/${x}/${y}`;
}

/**
 * Fill a tile URL template. Only the three XYZ placeholders are substituted,
 * and the template itself has already been origin- and path-checked by
 * `manifestSchema.ts`, so nothing user-controlled reaches this string.
 */
export function tileUrlFor(template: string, z: number, x: number, y: number): string {
  return template
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y));
}

export class SnowDataClient {
  private readonly tiles = new Map<TileKey, Promise<Uint8ClampedArray | null>>();

  constructor(
    private readonly template: string,
    private readonly zoom: number,
  ) {}

  /**
   * Snow data for each of `points`, in the same order, one cell per point.
   *
   * Points are grouped by tile so each tile is fetched once however many
   * samples land in it - a 10 km route at 60 m spacing is about 170 samples
   * across typically one or two tiles. A point whose tile fails to load gets
   * `UNKNOWN_CELL`; the route still reports everything it does know.
   */
  async sample(points: readonly { longitude: number; latitude: number }[]): Promise<SnowDataCell[]> {
    const addresses = points.map((point) => pixelAddressFor(point.longitude, point.latitude, this.zoom));

    const needed = new Map<TileKey, { z: number; x: number; y: number }>();
    for (const address of addresses) {
      needed.set(keyFor(address.z, address.x, address.y), address);
    }
    if (needed.size > MAX_TILES_PER_ROUTE) {
      // Not an error: a route this long is legitimate, we simply decline to
      // pull an unbounded number of tiles for it. Reported as unknown, which is
      // honest, rather than as a partial answer that looks complete.
      console.warn(`route spans ${needed.size} snow data tiles, over the ${MAX_TILES_PER_ROUTE} limit`);
      return points.map(() => UNKNOWN_CELL);
    }

    const loaded = new Map<TileKey, Uint8ClampedArray | null>();
    await Promise.all(
      [...needed.entries()].map(async ([key, address]) => {
        loaded.set(key, await this.loadTile(address.z, address.x, address.y));
      }),
    );

    return addresses.map((address) => {
      const pixels = loaded.get(keyFor(address.z, address.x, address.y));
      if (!pixels) return UNKNOWN_CELL;
      return decodeAt(pixels, address.px, address.py);
    });
  }

  private loadTile(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
    const key = keyFor(z, x, y);
    const cached = this.tiles.get(key);
    if (cached) return cached;

    const promise = this.fetchAndDecode(tileUrlFor(this.template, z, x, y));
    this.tiles.set(key, promise);
    return promise;
  }

  private fetchAndDecode(url: string): Promise<Uint8ClampedArray | null> {
    return new Promise((resolve) => {
      const image = new Image();
      // Without this the canvas is tainted and getImageData throws.
      image.crossOrigin = "anonymous";

      let settled = false;
      const finish = (value: Uint8ClampedArray | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      };

      const timer = window.setTimeout(() => {
        console.warn(`snow data tile timed out: ${url}`);
        finish(null);
      }, TILE_TIMEOUT_MS);

      image.addEventListener("load", () => {
        try {
          if (image.naturalWidth !== DATA_TILE_SIZE || image.naturalHeight !== DATA_TILE_SIZE) {
            // A tile of unexpected size is not this format; sampling it by
            // pixel index would read the wrong ground.
            console.warn(`snow data tile is ${image.naturalWidth}x${image.naturalHeight}, expected ${DATA_TILE_SIZE}`);
            finish(null);
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = DATA_TILE_SIZE;
          canvas.height = DATA_TILE_SIZE;
          // `willReadFrequently` keeps the browser from round-tripping this
          // through the GPU, which is both slower here and, on some drivers,
          // lossy for exact byte reads.
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) {
            finish(null);
            return;
          }
          context.drawImage(image, 0, 0);
          finish(context.getImageData(0, 0, DATA_TILE_SIZE, DATA_TILE_SIZE).data);
        } catch (error) {
          // A tainted canvas lands here. Unknown, never "no snow".
          console.warn(`snow data tile could not be read: ${String(error)}`);
          finish(null);
        }
      });

      // A 404 is ordinary: the pipeline writes only tiles with coverage.
      image.addEventListener("error", () => finish(null));
      image.src = url;
    });
  }
}
