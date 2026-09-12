/**
 * The chart's single window (spec 7.1 as amended by v1.13). Node runs this
 * TypeScript directly - no bundler, no DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HISTORY_WINDOW_DAYS,
  WindowRangeError,
  trailingRange,
} from "./seriesWindow.ts";

test("the default window is 30 days ending on the AS-OF date, inclusive", () => {
  const range = trailingRange("2026-09-12");
  assert.equal(range.end, "2026-09-12");
  assert.equal(range.start, "2026-08-14");
  assert.equal(HISTORY_WINDOW_DAYS, 30);
});

test("the window spans month boundaries", () => {
  assert.deepEqual(trailingRange("2026-03-05", 30), { start: "2026-02-04", end: "2026-03-05" });
});

test("the window spans a year boundary", () => {
  assert.deepEqual(trailingRange("2026-01-10", 30), { start: "2025-12-12", end: "2026-01-10" });
});

test("a leap day is an ordinary day inside the window", () => {
  assert.deepEqual(trailingRange("2028-03-01", 2), { start: "2028-02-29", end: "2028-03-01" });
});

test("a one-day window starts and ends on the same date", () => {
  assert.deepEqual(trailingRange("2026-09-12", 1), { start: "2026-09-12", end: "2026-09-12" });
});

test("a malformed AS-OF date is rejected rather than silently coerced", () => {
  assert.throws(() => trailingRange("12/09/2026"), WindowRangeError);
  assert.throws(() => trailingRange(""), WindowRangeError);
});

test("a non-positive or fractional day count is rejected", () => {
  for (const days of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => trailingRange("2026-09-12", days), WindowRangeError);
  }
});
