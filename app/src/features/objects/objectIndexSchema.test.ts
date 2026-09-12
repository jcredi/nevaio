/**
 * Tests for the sharded OSM object index validator.
 *
 * Run with `npm test` (Node runs the TypeScript directly - no bundler,
 * browser or map). Every rejection case is something a corrupted, truncated
 * or hostile publication could otherwise have put in the panel or used as a
 * snow-history identity - or, for the shard paths, somewhere it could have
 * sent the browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ObjectIndexError,
  OBJECT_INDEX_SCHEMA_VERSION,
  boundsIntersect,
  shardsFor,
  validateObjectShard,
  validateShardIndex,
  type Bounds,
  type ShardDescriptor,
} from "./objectIndexSchema.ts";

const PAGE = "https://nevaio.netlify.app/";
const INDEX_URL = "https://pub-example.r2.dev/osm/object-index.json";

/** A shard entry in the shape the pipeline really publishes. */
function shard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tile: "31TFK",
    path: "objects/31TFK.json",
    bounds: [4.8808182, 44.1466161079487, 5.6655488, 45.1257038],
    objectCount: 2742,
    bytes: 370495,
    sha256: "c5c649104e5564dc0be4157bfce11d8c1b847b73594e1ea777eae9720d68a943",
    ...overrides,
  };
}

function index(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: OBJECT_INDEX_SCHEMA_VERSION,
    objectCount: 2742,
    shards: [shard()],
    ...overrides,
  };
}

/** The record shape a shard really holds. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "node/414760065",
    kind: "peak",
    name: "Dufourspitze",
    longitude: 7.866757,
    latitude: 45.936924,
    elevationMeters: 4634,
    ...overrides,
  };
}

function descriptor(overrides: Partial<ShardDescriptor> = {}): ShardDescriptor {
  return {
    tile: "32TMR",
    url: "https://pub-example.r2.dev/osm/objects/32TMR.json",
    bounds: [7, 45, 8, 46],
    objectCount: 1,
    bytes: 100,
    sha256: "0".repeat(64),
    ...overrides,
  };
}

function shardDocument(objects: unknown[], tile = "32TMR"): Record<string, unknown> {
  return { schemaVersion: OBJECT_INDEX_SCHEMA_VERSION, tile, objects };
}

function rejects(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ObjectIndexError, `expected ObjectIndexError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("validateShardIndex", () => {
  it("accepts the entry point the pipeline publishes and resolves shard URLs", () => {
    const result = validateShardIndex(index(), INDEX_URL, PAGE);
    assert.equal(result.objectCount, 2742);
    assert.equal(result.shards.length, 1);
    assert.equal(result.shards[0].url, "https://pub-example.r2.dev/osm/objects/31TFK.json");
    assert.deepEqual(result.shards[0].bounds, [
      4.8808182, 44.1466161079487, 5.6655488, 45.1257038,
    ]);
  });

  it("accepts many shards whose counts add up, including overlapping bounds", () => {
    // Mont Blanc really is in both 31TGL and 32TLR; overlap is not an error.
    const result = validateShardIndex(
      index({
        objectCount: 3,
        shards: [
          shard({ tile: "31TGL", path: "objects/31TGL.json", objectCount: 1, bounds: [6, 45, 7, 46] }),
          shard({ tile: "32TLR", path: "objects/32TLR.json", objectCount: 2, bounds: [6.5, 45.5, 7.5, 46.5] }),
        ],
      }),
      INDEX_URL,
      PAGE,
    );
    assert.equal(result.shards.length, 2);
  });

  it("accepts a relative index URL resolved against the page", () => {
    const result = validateShardIndex(index(), "/object-index/object-index.json", PAGE);
    assert.equal(
      result.shards[0].url,
      "https://nevaio.netlify.app/object-index/objects/31TFK.json",
    );
  });

  it("refuses a shard path pointing at another origin", () => {
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "https://evil.example/x.json" })] }), INDEX_URL, PAGE),
      /points at https:\/\/evil\.example/,
    );
  });

  it("refuses a protocol-relative path, which changes host silently", () => {
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "//evil.example/x.json" })] }), INDEX_URL, PAGE),
      /points at https:\/\/evil\.example/,
    );
  });

  it("refuses a path that escapes the index directory", () => {
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "../../secrets.json" })] }), INDEX_URL, PAGE),
      /escapes the index directory/,
    );
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "/elsewhere/x.json" })] }), INDEX_URL, PAGE),
      /escapes the index directory/,
    );
  });

  it("refuses a data: or javascript: path", () => {
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "data:application/json,{}" })] }), INDEX_URL, PAGE),
      /points at |changes the scheme/,
    );
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "javascript:alert(1)" })] }), INDEX_URL, PAGE),
      /points at |changes the scheme/,
    );
  });

  it("refuses embedded credentials, a query string or a fragment", () => {
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "https://a:b@pub-example.r2.dev/osm/objects/x.json" })] }), INDEX_URL, PAGE),
      /credentials|points at/,
    );
    rejects(
      () => validateShardIndex(index({ shards: [shard({ path: "objects/31TFK.json?token=1" })] }), INDEX_URL, PAGE),
      /query string or fragment/,
    );
  });

  it("refuses an unknown schema version or a non-object document", () => {
    rejects(() => validateShardIndex(index({ schemaVersion: 2 }), INDEX_URL, PAGE), /schemaVersion 2/);
    rejects(() => validateShardIndex([], INDEX_URL, PAGE), /must be a JSON object/);
  });

  it("refuses counts that contradict each other", () => {
    rejects(
      () => validateShardIndex(index({ objectCount: 9999 }), INDEX_URL, PAGE),
      /shards list 2742 objects but objectCount is 9999/,
    );
  });

  it("refuses a tile that is not an MGRS square, or a repeated one", () => {
    rejects(() => validateShardIndex(index({ shards: [shard({ tile: "../x" })] }), INDEX_URL, PAGE), /not an MGRS square/);
    rejects(
      () =>
        validateShardIndex(
          index({ objectCount: 5484, shards: [shard(), shard({ path: "objects/other.json" })] }),
          INDEX_URL,
          PAGE,
        ),
      /duplicate shard tile 31TFK/,
    );
  });

  it("refuses impossible bounds", () => {
    rejects(() => validateShardIndex(index({ shards: [shard({ bounds: [10, 45, 5, 46] })] }), INDEX_URL, PAGE), /longitudes/);
    rejects(() => validateShardIndex(index({ shards: [shard({ bounds: [5, 46, 6, 45] })] }), INDEX_URL, PAGE), /latitudes/);
    rejects(() => validateShardIndex(index({ shards: [shard({ bounds: [5, 45, 6] })] }), INDEX_URL, PAGE), /four numbers/);
  });

  it("refuses a malformed digest or an implausible size", () => {
    rejects(() => validateShardIndex(index({ shards: [shard({ sha256: "not-a-digest" })] }), INDEX_URL, PAGE), /lowercase hex digest/);
    rejects(() => validateShardIndex(index({ shards: [shard({ sha256: "C5C6".repeat(16) })] }), INDEX_URL, PAGE), /lowercase hex digest/);
    rejects(() => validateShardIndex(index({ shards: [shard({ bytes: 1 << 30 })] }), INDEX_URL, PAGE), /bytes must be between/);
  });

  it("refuses a shard list that is not an array, or is absurdly long", () => {
    rejects(() => validateShardIndex(index({ shards: {} }), INDEX_URL, PAGE), /shards must be an array/);
    const many = Array.from({ length: 501 }, (_unused, i) =>
      shard({ tile: `31TF${String.fromCharCode(65 + (i % 26))}`, path: `objects/${i}.json` }),
    );
    rejects(() => validateShardIndex(index({ shards: many }), INDEX_URL, PAGE), /over the 500 limit/);
  });
});

describe("validateObjectShard", () => {
  it("accepts the shard shape the pipeline publishes", () => {
    const result = validateObjectShard(shardDocument([record()]), descriptor());
    assert.equal(result.tile, "32TMR");
    assert.equal(result.objects.length, 1);
    assert.equal(result.objects[0].id, "node/414760065");
  });

  it("accepts an object with no elevation, which is the common case", () => {
    const result = validateObjectShard(
      shardDocument([record({ elevationMeters: null })]),
      descriptor(),
    );
    assert.equal(result.objects[0].elevationMeters, null);
  });

  it("accepts an empty shard", () => {
    const result = validateObjectShard(shardDocument([]), descriptor({ objectCount: 0 }));
    assert.deepEqual(result.objects, []);
  });

  it("keeps only the contract's own fields", () => {
    const result = validateObjectShard(
      shardDocument([record({ osmTags: { natural: "peak" } })]),
      descriptor(),
    );
    // "tile" is expected here too: it is stamped from the shard's own
    // validated `tile` field (never from the record's own JSON), so it is
    // part of the contract this test locks down, not a leak from `osmTags`.
    assert.deepEqual(Object.keys(result.objects[0]).sort(), [
      "elevationMeters",
      "id",
      "kind",
      "latitude",
      "longitude",
      "name",
      "tile",
    ]);
  });

  it("refuses a shard that is not the one that was requested", () => {
    rejects(
      () => validateObjectShard(shardDocument([record()], "31TFK"), descriptor()),
      /shard says it is 31TFK but was fetched as 32TMR/,
    );
  });

  it("refuses a shard whose length contradicts the index", () => {
    rejects(
      () => validateObjectShard(shardDocument([record(), record({ id: "node/2" })]), descriptor()),
      /holds 2 objects, but the index promised 1/,
    );
  });

  it("refuses an identity that is not <osmType>/<osmId>", () => {
    // A bare number and the *10-encoded MapTiler poi id are both things that
    // could plausibly be handed to us by mistake.
    rejects(() => validateObjectShard(shardDocument([record({ id: "414760065" })]), descriptor()), /identity/);
    rejects(() => validateObjectShard(shardDocument([record({ id: "node/0" })]), descriptor()), /identity/);
    rejects(() => validateObjectShard(shardDocument([record({ id: "point/12" })]), descriptor()), /identity/);
    rejects(() => validateObjectShard(shardDocument([record({ id: 414760065 })]), descriptor()), /must be a string/);
  });

  it("refuses a class outside the six selectable ones", () => {
    // Rendered basemap vocabulary is not this contract's vocabulary.
    rejects(() => validateObjectShard(shardDocument([record({ kind: "viewpoint" })]), descriptor()), /not a selectable class/);
    rejects(() => validateObjectShard(shardDocument([record({ kind: "PEAK" })]), descriptor()), /not a selectable class/);
  });

  it("refuses a missing or over-long name", () => {
    // The pipeline skips unnamed source records deliberately.
    rejects(() => validateObjectShard(shardDocument([record({ name: "" })]), descriptor()), /must not be empty/);
    rejects(() => validateObjectShard(shardDocument([record({ name: "x".repeat(201) })]), descriptor()), /over the 200 limit/);
  });

  it("refuses coordinates that are not real finite positions", () => {
    rejects(() => validateObjectShard(shardDocument([record({ longitude: 181 })]), descriptor()), /longitude must be between/);
    rejects(() => validateObjectShard(shardDocument([record({ latitude: Number.NaN })]), descriptor()), /latitude must be a finite number/);
    rejects(() => validateObjectShard(shardDocument([record({ latitude: "45.9" })]), descriptor()), /latitude must be a finite number/);
  });

  it("refuses an implausible elevation", () => {
    rejects(() => validateObjectShard(shardDocument([record({ elevationMeters: 90000 })]), descriptor()), /between -500 and 9000/);
  });

  it("refuses a duplicate identity rather than picking one", () => {
    rejects(
      () => validateObjectShard(shardDocument([record(), record()]), descriptor({ objectCount: 2 })),
      /duplicate object id node\/414760065/,
    );
  });
});

describe("shardsFor", () => {
  const built = validateShardIndex(
    index({
      objectCount: 3,
      shards: [
        shard({ tile: "31TGL", path: "objects/31TGL.json", objectCount: 1, bounds: [6, 45, 7, 46] }),
        shard({ tile: "32TLR", path: "objects/32TLR.json", objectCount: 2, bounds: [6.5, 45.5, 7.5, 46.5] }),
      ],
    }),
    INDEX_URL,
    PAGE,
  );

  it("returns every shard overlapping the viewport, not just one", () => {
    // The seam region belongs to both shards; assuming one would lose objects.
    const seam: Bounds = [6.6, 45.6, 6.9, 45.9];
    assert.deepEqual(
      shardsFor(built, seam).map((s) => s.tile),
      ["31TGL", "32TLR"],
    );
  });

  it("returns one shard away from the seam", () => {
    assert.deepEqual(
      shardsFor(built, [6.1, 45.1, 6.2, 45.2]).map((s) => s.tile),
      ["31TGL"],
    );
  });

  it("returns nothing where the publication holds nothing", () => {
    assert.deepEqual(shardsFor(built, [0, 0, 1, 1]), []);
  });

  it("treats a touching edge as an intersection", () => {
    assert.equal(boundsIntersect([0, 0, 1, 1], [1, 1, 2, 2]), true);
    assert.equal(boundsIntersect([0, 0, 1, 1], [1.001, 0, 2, 1]), false);
  });
});
