/**
 * Tests for the chart period presets (spec section 7.1). Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_CUSTOM_RANGE_DAYS,
  PresetRangeError,
  customRange,
  fixedPresetRange,
  previousYearRange,
  trailingRange,
} from "./seriesPresets.ts";

describe("trailingRange / fixedPresetRange", () => {
  it("last30 ends on the AS-OF date and spans exactly 30 inclusive days", () => {
    const range = fixedPresetRange("last30", "2026-09-12");
    assert.deepEqual(range, { start: "2026-08-14", end: "2026-09-12" });
  });

  it("last90 and lastYear are also anchored on AS-OF, not on today", () => {
    assert.deepEqual(fixedPresetRange("last90", "2026-01-05"), {
      start: "2025-10-08",
      end: "2026-01-05",
    });
    assert.deepEqual(fixedPresetRange("lastYear", "2026-09-12"), {
      start: "2025-09-13",
      end: "2026-09-12",
    });
  });

  it("a single-day window is a valid trailing range", () => {
    assert.deepEqual(trailingRange("2026-09-12", 1), { start: "2026-09-12", end: "2026-09-12" });
  });

  it("rejects a non-positive or non-integer day count", () => {
    assert.throws(() => trailingRange("2026-09-12", 0), PresetRangeError);
    assert.throws(() => trailingRange("2026-09-12", -5), PresetRangeError);
    assert.throws(() => trailingRange("2026-09-12", 1.5), PresetRangeError);
  });

  it("rejects a malformed AS-OF date", () => {
    assert.throws(() => fixedPresetRange("last30", "12-09-2026"), PresetRangeError);
  });
});

describe("customRange", () => {
  it("accepts an ordered pair", () => {
    assert.deepEqual(customRange("2026-06-01", "2026-06-30"), {
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });

  it("accepts a single-day range", () => {
    assert.deepEqual(customRange("2026-06-01", "2026-06-01"), {
      start: "2026-06-01",
      end: "2026-06-01",
    });
  });

  it("rejects a reversed pair", () => {
    assert.throws(() => customRange("2026-06-30", "2026-06-01"), PresetRangeError);
  });

  it("rejects a span over the limit, and accepts one exactly at it", () => {
    assert.throws(() => customRange("2024-01-01", "2026-01-02"), PresetRangeError);
    // Exactly MAX_CUSTOM_RANGE_DAYS inclusive days starting 2026-01-01.
    const end = new Date(Date.UTC(2026, 0, 1) + (MAX_CUSTOM_RANGE_DAYS - 1) * 86_400_000);
    const endIso = end.toISOString().slice(0, 10);
    assert.doesNotThrow(() => customRange("2026-01-01", endIso));
  });

  it("rejects a malformed date", () => {
    assert.throws(() => customRange("2026/06/01", "2026-06-30"), PresetRangeError);
  });
});

describe("previousYearRange", () => {
  it("shifts both ends back exactly one calendar year", () => {
    assert.deepEqual(previousYearRange({ start: "2026-06-01", end: "2026-06-30" }), {
      start: "2025-06-01",
      end: "2025-06-30",
    });
  });

  it("clamps a Feb 29 start into a non-leap previous year rather than overflowing to March", () => {
    // 2028 is a leap year; 2027 is not.
    assert.deepEqual(previousYearRange({ start: "2028-02-29", end: "2028-03-01" }), {
      start: "2027-02-28",
      end: "2027-03-01",
    });
  });
});
