/**
 * Tests for the per-tile slot map validator. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlotMapError, slotFor, validateSlotMap } from "./slotMapSchema.ts";

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tile: "31TFK",
    slotCount: 2,
    slotIds: ["node/123", "way/456"],
    ...overrides,
  };
}

function rejects(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof SlotMapError, `expected SlotMapError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("validateSlotMap", () => {
  it("accepts the document the pipeline publishes", () => {
    const result = validateSlotMap(doc(), "31TFK");
    assert.deepEqual(result.slotIds, ["node/123", "way/456"]);
    assert.equal(result.slotCount, 2);
  });

  it("accepts an empty slot map (a brand-new tile)", () => {
    const result = validateSlotMap(doc({ slotCount: 0, slotIds: [] }), "31TFK");
    assert.deepEqual(result.slotIds, []);
  });

  it("refuses a document fetched for the wrong tile", () => {
    rejects(() => validateSlotMap(doc(), "32TMR"), /fetched as 32TMR/);
  });

  it("refuses a tile that is not an MGRS square", () => {
    rejects(() => validateSlotMap(doc({ tile: "../x" }), "../x"), /not an MGRS square/);
  });

  it("refuses an unsupported schemaVersion or a non-object document", () => {
    rejects(() => validateSlotMap(doc({ schemaVersion: 2 }), "31TFK"), /schemaVersion 2/);
    rejects(() => validateSlotMap([], "31TFK"), /must be a JSON object/);
  });

  it("refuses a malformed object id", () => {
    rejects(() => validateSlotMap(doc({ slotIds: ["not-an-id", "way/456"], slotCount: 2 }), "31TFK"), /not an <osmType>\/<osmId>/);
  });

  it("refuses a duplicate id, which would make a slot lookup ambiguous", () => {
    rejects(
      () => validateSlotMap(doc({ slotIds: ["node/123", "node/123"], slotCount: 2 }), "31TFK"),
      /duplicate object id/,
    );
  });

  it("refuses a slotCount that contradicts slotIds", () => {
    rejects(() => validateSlotMap(doc({ slotCount: 5 }), "31TFK"), /slotCount is 5 but slotIds holds 2/);
  });

  it("refuses slotIds that is not an array, or absurdly long", () => {
    rejects(() => validateSlotMap(doc({ slotIds: "nope" }), "31TFK"), /slotIds must be an array/);
  });
});

describe("slotFor", () => {
  it("returns the row index for a known id, and null for an unknown one", () => {
    const slotMap = validateSlotMap(doc(), "31TFK");
    assert.equal(slotFor(slotMap, "node/123"), 0);
    assert.equal(slotFor(slotMap, "way/456"), 1);
    assert.equal(slotFor(slotMap, "node/999"), null);
  });
});
