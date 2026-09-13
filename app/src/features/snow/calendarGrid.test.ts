/**
 * Tests for the date picker's calendar layout.
 *
 * Run with `npm test`. The arithmetic here is all UTC day-stepping, which is
 * exactly where a timezone bug hides: a grid built in local time drifts by a
 * day for anyone west of Greenwich, and the symptom is a user tapping one date
 * and loading another.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WEEKDAY_LABELS, calendarTitle, calendarWeeks } from "./calendarGrid.ts";

const flat = (weeks: ReturnType<typeof calendarWeeks>) => weeks.flat();

describe("calendarWeeks", () => {
  it("returns whole Monday-first weeks", () => {
    const weeks = calendarWeeks(["2026-09-13", "2026-09-11"]);
    assert.equal(WEEKDAY_LABELS.length, 7);
    for (const week of weeks) assert.equal(week.length, 7);
  });

  it("puts each date under its own weekday column", () => {
    // 2026-09-11 is a Friday, so it must land in column 4 (Mon = 0).
    const weeks = calendarWeeks(["2026-09-11"]);
    const cells = flat(weeks);
    const index = cells.findIndex((cell) => cell.iso === "2026-09-11");
    assert.equal(index % 7, 4);
    assert.equal(WEEKDAY_LABELS[index % 7], "Fri");
  });

  it("covers exactly the span of the catalogue, padded to whole weeks", () => {
    const weeks = calendarWeeks(["2026-09-13", "2026-09-01"]);
    const dated = flat(weeks).filter((cell) => cell.iso !== null);
    assert.equal(dated[0].iso, "2026-09-01");
    assert.equal(dated[dated.length - 1].iso, "2026-09-13");
    assert.equal(dated.length, 13);
  });

  it("marks a hole in the window as present but unavailable", () => {
    // The 12th failed to publish. It must still occupy its square, because a
    // visible gap is information; renumbering around it would be a lie.
    const weeks = calendarWeeks(["2026-09-13", "2026-09-11"]);
    const cells = flat(weeks);
    const missing = cells.find((cell) => cell.iso === "2026-09-12");
    assert.ok(missing, "the gap day must still have a cell");
    assert.equal(missing.available, false);
    assert.equal(cells.find((cell) => cell.iso === "2026-09-13")?.available, true);
  });

  it("steps days in UTC, not in the local timezone", () => {
    // The whole grid is built by adding 86_400_000 ms, so a run in a
    // west-of-Greenwich zone must still produce the same ISO strings. Every
    // consecutive pair must differ by exactly one calendar day.
    const weeks = calendarWeeks(["2026-03-01", "2026-03-31"]);
    const dated = flat(weeks).filter((cell) => cell.iso !== null);
    assert.equal(dated.length, 31);
    for (let i = 1; i < dated.length; i += 1) {
      const previous = Date.parse(`${dated[i - 1].iso}T00:00:00Z`);
      const current = Date.parse(`${dated[i].iso}T00:00:00Z`);
      assert.equal(current - previous, 86_400_000, `gap at ${dated[i].iso}`);
    }
  });

  it("survives a span crossing a month and a DST change", () => {
    // Europe moves its clocks on the last Sunday of March. UTC stepping must
    // not notice.
    const weeks = calendarWeeks(["2026-03-25", "2026-04-05"]);
    const dated = flat(weeks).filter((cell) => cell.iso !== null);
    assert.equal(dated[0].iso, "2026-03-25");
    assert.equal(dated[dated.length - 1].iso, "2026-04-05");
    assert.equal(dated.length, 12);
    assert.equal(dated.find((cell) => cell.iso === "2026-04-01")?.monthStart, true);
    assert.equal(dated.find((cell) => cell.iso === "2026-03-25")?.monthStart, false);
  });

  it("handles one date and no dates without inventing a grid", () => {
    assert.deepEqual(calendarWeeks([]), []);
    const single = calendarWeeks(["2026-09-13"]);
    assert.equal(single.length, 1);
    assert.equal(flat(single).filter((cell) => cell.iso !== null).length, 1);
  });

  it("does not care what order the catalogue lists its dates in", () => {
    const newestFirst = calendarWeeks(["2026-09-13", "2026-09-12", "2026-09-11"]);
    const shuffled = calendarWeeks(["2026-09-12", "2026-09-11", "2026-09-13"]);
    assert.deepEqual(newestFirst, shuffled);
  });
});

describe("calendarTitle", () => {
  /**
   * The platform's own short month name, not a literal. ICU spells September
   * "Sept" in en-GB and "Sep" in some other builds; pinning either would make
   * this test a report on the Node build rather than on this module, and the
   * app's existing `formatProductDate` already renders whatever ICU says.
   */
  const shortMonth = (iso: string): string =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

  it("names one month, two months, and a year boundary", () => {
    assert.equal(calendarTitle(["2026-09-01", "2026-09-13"]), `${shortMonth("2026-09-01")} 2026`);
    assert.equal(
      calendarTitle(["2026-08-20", "2026-09-13"]),
      `${shortMonth("2026-08-20")} - ${shortMonth("2026-09-13")} 2026`,
    );
    assert.equal(
      calendarTitle(["2025-12-20", "2026-01-05"]),
      `${shortMonth("2025-12-20")} 2025 - ${shortMonth("2026-01-05")} 2026`,
    );
    assert.equal(calendarTitle([]), "");
  });

  it("collapses to one month only when the span really is one month", () => {
    assert.ok(!calendarTitle(["2026-09-01", "2026-09-13"]).includes("-"));
    assert.ok(calendarTitle(["2026-08-31", "2026-09-01"]).includes("-"));
  });
});
