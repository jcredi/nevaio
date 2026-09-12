/**
 * The loading boundary for the static, sharded OSM object index.
 *
 * Everything provider-specific about *where* the index comes from lives here
 * and nowhere else. Since 2026-09-12 that is the real R2 publication - 54
 * shards, 211,881 objects - and the old `public/object-index/` fixture is
 * gone; the URL is the one in `../map/config.ts` and nothing else.
 *
 * The R2 bucket host was already in `app/public/_headers`' `connect-src` (it
 * serves the snow manifest), so this needed no new CSP origin. Any *other*
 * host would.
 *
 * Shards are fetched lazily. The full published set is 54 shards / 39 MB; a
 * viewport touches one to a handful, and shard extents legitimately overlap at
 * UTM zone seams, so "which shards" is a box intersection, never a lookup.
 */
import {
  ObjectIndexError,
  shardsFor,
  validateObjectShard,
  validateShardIndex,
  type Bounds,
  type ObjectRecord,
  type ShardDescriptor,
  type ShardIndex,
} from "./objectIndexSchema.ts";

/** A shard bigger than this is a pipeline mistake, not something to parse on a phone. */
const MAX_SHARD_BYTES = 16 * 1024 * 1024;
/** The entry point is ~11 KB today. */
const MAX_INDEX_BYTES = 1024 * 1024;

export class ObjectIndexLoadError extends Error {}

async function fetchBytes(url: string, limit: number, what: string): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch (error) {
    throw new ObjectIndexLoadError(`could not fetch ${what}: ${String(error)}`);
  }
  if (!response.ok) {
    throw new ObjectIndexLoadError(`${what} request failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ObjectIndexLoadError(`${what} declares ${declared} bytes, over the ${limit} limit`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > limit) {
    throw new ObjectIndexLoadError(`${what} is ${body.byteLength} bytes, over the ${limit} limit`);
  }
  return body;
}

function parse(body: ArrayBuffer, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new ObjectIndexLoadError(`${what} is not valid JSON: ${String(error)}`);
  }
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check a shard against the `bytes` and `sha256` the index promised.
 *
 * The origin/directory pin in the validator is the control that matters - it
 * is what stops a poisoned index redirecting the browser. This is a second,
 * cheaper layer: it catches a truncated or mis-built shard, and it makes the
 * index and its shards verifiably one publication rather than two files that
 * happen to sit together.
 *
 * `crypto.subtle` exists only in a secure context. Production is HTTPS and
 * local dev is served from 127.0.0.1, both of which qualify; anywhere else the
 * digest is skipped with a warning rather than failing the load, because the
 * origin pin is still in force.
 */
async function verifyShardBytes(body: ArrayBuffer, shard: ShardDescriptor): Promise<void> {
  if (body.byteLength !== shard.bytes) {
    throw new ObjectIndexLoadError(
      `shard ${shard.tile} is ${body.byteLength} bytes, but the index promised ${shard.bytes}`,
    );
  }
  if (!globalThis.crypto?.subtle) {
    console.warn(`Skipping shard ${shard.tile} digest check: no SubtleCrypto in this context`);
    return;
  }
  const digest = hex(await crypto.subtle.digest("SHA-256", body));
  if (digest !== shard.sha256) {
    throw new ObjectIndexLoadError(
      `shard ${shard.tile} digest ${digest} does not match the index's ${shard.sha256}`,
    );
  }
}

/**
 * The loaded part of the object index.
 *
 * Holds the validated entry point plus whichever shards have been needed so
 * far, and answers "which records could a tap in this box hit". Callers get
 * `records()` - a plain array - so the matching rule stays pure and knows
 * nothing about shards or the network.
 */
export class ObjectIndexStore {
  private index: ShardIndex | null = null;
  private readonly shards = new Map<string, ObjectRecord[]>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private failedShards = 0;

  constructor(
    private readonly indexUrl: string,
    private readonly pageUrl: string,
  ) {}

  /** Fetch and validate the entry point. Call once. */
  async loadIndex(): Promise<void> {
    const body = await fetchBytes(this.indexUrl, MAX_INDEX_BYTES, "object index");
    try {
      this.index = validateShardIndex(parse(body, "object index"), this.indexUrl, this.pageUrl);
    } catch (error) {
      if (error instanceof ObjectIndexError) throw new ObjectIndexLoadError(error.message);
      throw error;
    }
  }

  /** Total objects the publication claims, across every shard. */
  get objectCount(): number {
    return this.index?.objectCount ?? 0;
  }

  /** True once at least one shard covering `viewport` is loaded and non-empty. */
  hasCoverage(viewport: Bounds): boolean {
    if (!this.index) return false;
    const needed = shardsFor(this.index, viewport);
    return needed.length === 0 || needed.every((shard) => this.shards.has(shard.tile));
  }

  /** How many shard loads have failed, so the UI can be honest about gaps. */
  get failures(): number {
    return this.failedShards;
  }

  /**
   * Ensure every shard overlapping `viewport` is loaded.
   *
   * Concurrent calls for the same shard share one request; a shard that fails
   * is counted and retried on the next call rather than poisoning the store.
   */
  async ensureLoaded(viewport: Bounds): Promise<void> {
    if (!this.index) return;
    const wanted = shardsFor(this.index, viewport).filter(
      (shard) => !this.shards.has(shard.tile),
    );
    await Promise.all(wanted.map((shard) => this.loadShard(shard)));
  }

  /** Records from every loaded shard. */
  records(): ObjectRecord[] {
    const all: ObjectRecord[] = [];
    for (const records of this.shards.values()) all.push(...records);
    return all;
  }

  private loadShard(shard: ShardDescriptor): Promise<void> {
    const existing = this.inFlight.get(shard.tile);
    if (existing) return existing;

    const work = (async () => {
      const body = await fetchBytes(shard.url, MAX_SHARD_BYTES, `shard ${shard.tile}`);
      await verifyShardBytes(body, shard);
      try {
        const parsed = validateObjectShard(parse(body, `shard ${shard.tile}`), shard);
        this.shards.set(shard.tile, parsed.objects);
      } catch (error) {
        if (error instanceof ObjectIndexError) throw new ObjectIndexLoadError(error.message);
        throw error;
      }
    })()
      .catch((error) => {
        this.failedShards += 1;
        console.error(`Object index shard ${shard.tile} failed to load`, error);
      })
      .finally(() => {
        this.inFlight.delete(shard.tile);
      });

    this.inFlight.set(shard.tile, work);
    return work;
  }
}
