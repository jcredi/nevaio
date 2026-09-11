/**
 * Tests for the static OSM object index validator.
 *
 * Run with `npm test` (Node runs the TypeScript directly - no bundler,
 * browser or map). Every rejection case is something a corrupted, truncated
 * or hostile index could otherwise have put in the panel or used as a
 * snow-history identity.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ObjectIndexError,
  OBJECT_INDEX_SCHEMA_VERSION,
  validateObjectIndex,
} from "./objectIndexSchema.ts";

/** The shape nevaio_pipeline.object_index really writes. */
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

function index(objects: unknown[]): Record<string, unknown> {
  return { schemaVersion: OBJECT_INDEX_SCHEMA_VERSION, objects };
}

function rejects(document: unknown, pattern: RegExp): void {
  assert.throws(
    () => validateObjectIndex(document),
    (error: unknown) => {
      assert.ok(error instanceof ObjectIndexError, `expected ObjectIndexError, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe("validateObjectIndex", () => {
  it("accepts the document shape the pipeline publishes", () => {
    const result = validateObjectIndex(
      index([
        record(),
        record({
          id: "node/465923948",
          kind: "saddle",
          name: "Valico Taglio Grosso",
          longitude: 8.2,
          latitude: 45.8,
          elevationMeters: 586,
        }),
      ]),
    );
    assert.equal(result.objects.length, 2);
    assert.equal(result.objects[0].id, "node/414760065");
    assert.equal(result.objects[1].kind, "saddle");
  });

  it("accepts an object with no elevation", () => {
    const result = validateObjectIndex(index([record({ elevationMeters: null })]));
    assert.equal(result.objects[0].elevationMeters, null);
  });

  it("accepts an empty index", () => {
    assert.deepEqual(validateObjectIndex(index([])).objects, []);
  });

  it("keeps only the contract's own fields", () => {
    const result = validateObjectIndex(index([record({ osmTags: { natural: "peak" } })]));
    assert.deepEqual(Object.keys(result.objects[0]).sort(), [
      "elevationMeters",
      "id",
      "kind",
      "latitude",
      "longitude",
      "name",
    ]);
  });

  it("rejects a non-object document", () => {
    rejects([], /must be a JSON object/);
    rejects(null, /must be a JSON object/);
    rejects("{}", /must be a JSON object/);
  });

  it("rejects an unknown schema version", () => {
    rejects({ schemaVersion: 2, objects: [] }, /unsupported object index schemaVersion 2/);
    rejects({ objects: [] }, /unsupported object index schemaVersion undefined/);
  });

  it("rejects a missing or non-array objects field", () => {
    rejects({ schemaVersion: 1 }, /objects must be an array/);
    rejects({ schemaVersion: 1, objects: {} }, /objects must be an array/);
  });

  it("rejects an identity that is not <osmType>/<osmId>", () => {
    // A bare number, a MapTiler MVT feature id, and the *10-encoded planet poi
    // id are all things that could plausibly be handed to us by mistake.
    rejects(index([record({ id: "414760065" })]), /not an <osmType>\/<osmId> identity/);
    rejects(index([record({ id: "node/0" })]), /not an <osmType>\/<osmId> identity/);
    rejects(index([record({ id: "way/97320349/1" })]), /not an <osmType>\/<osmId> identity/);
    rejects(index([record({ id: "point/12" })]), /not an <osmType>\/<osmId> identity/);
    rejects(index([record({ id: 414760065 })]), /objects\[0\]\.id must be a string/);
  });

  it("rejects a class outside the six selectable ones", () => {
    // Rendered basemap vocabulary is not this contract's vocabulary.
    rejects(index([record({ kind: "viewpoint" })]), /not a selectable class: viewpoint/);
    rejects(index([record({ kind: "guidepost" })]), /not a selectable class: guidepost/);
    rejects(index([record({ kind: "PEAK" })]), /not a selectable class: PEAK/);
  });

  it("rejects a missing or over-long name", () => {
    // The pipeline skips unnamed source records deliberately (worklog
    // 2026-09-11); an unnamed record here means that rule was bypassed.
    rejects(index([record({ name: "" })]), /objects\[0\]\.name must not be empty/);
    rejects(index([record({ name: undefined })]), /objects\[0\]\.name must be a string/);
    rejects(index([record({ name: "x".repeat(201) })]), /over the 200 limit/);
  });

  it("rejects coordinates that are not real finite positions", () => {
    rejects(index([record({ longitude: 181 })]), /longitude must be between -180 and 180/);
    rejects(index([record({ latitude: -91 })]), /latitude must be between -90 and 90/);
    rejects(index([record({ longitude: Number.NaN })]), /longitude must be a finite number/);
    rejects(index([record({ latitude: "45.9" })]), /latitude must be a finite number/);
    rejects(index([record({ longitude: undefined })]), /longitude must be a finite number/);
  });

  it("rejects an implausible elevation", () => {
    rejects(index([record({ elevationMeters: 90000 })]), /between -500 and 9000/);
    rejects(index([record({ elevationMeters: "4634" })]), /must be a finite number/);
  });

  it("rejects a duplicate identity rather than picking one", () => {
    rejects(index([record(), record({ name: "Monte Rosa" })]), /duplicate object id node\/414760065/);
  });

  it("rejects an index far larger than any shippable shard", () => {
    const objects = Array.from({ length: 50_001 }, (_unused, i) => record({ id: `node/${i + 1}` }));
    rejects(index(objects), /over the 50000 limit/);
  });
});
