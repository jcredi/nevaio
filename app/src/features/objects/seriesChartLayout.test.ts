/**
 * Tests for the snow-history chart's pure geometry (spec section 7.1). This
 * is where the "no interpolation across a gap" rule is actually asserted,
 * rather than merely eyeballed in a browser: every test that puts a
 * cloud/no_data/stale day between two valid ones checks that no line segment
 * spans it.
 *
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildChartLayout, type DayCell } from "./seriesChartLayout.ts";
import type { SeriesCell } from "./seriesFormat.ts";

const CONFIG = {
  width: 300,
  height: 120,
  padding: { top: 10, right: 10, bottom: 20, left: 30 },
};

function valid(gf: number, quality = 0, ageDays = 0): SeriesCell {
  return { state: "valid", gf, quality, ageDays };
}
function cloud(): SeriesCell {
  return { state: "cloud", gf: null, quality: null, ageDays: null };
}
function noData(): SeriesCell {
  return { state: "no_data", gf: null, quality: null, ageDays: null };
}
function stale(gf: number, quality = 0): SeriesCell {
  return { state: "stale", gf, quality, ageDays: null };
}

function day(date: string, cell: SeriesCell): DayCell {
  return { date, cell };
}

describe("buildChartLayout - segments never cross a gap", () => {
  it("connects two immediately-adjacent valid days with one segment", () => {
    const layout = buildChartLayout(
      [day("2026-09-01", valid(10)), day("2026-09-02", valid(20))],
      CONFIG,
    );
    assert.equal(layout.segments.length, 1);
    assert.equal(layout.segments[0].points.length, 2);
    assert.equal(layout.gapTicks.length, 0);
  });

  it("breaks the line at a cloud day between two valid days", () => {
    const layout = buildChartLayout(
      [day("2026-09-01", valid(10)), day("2026-09-02", cloud()), day("2026-09-03", valid(30))],
      CONFIG,
    );
    // Two isolated points, not one segment spanning the gap.
    assert.equal(layout.segments.length, 2);
    assert.equal(layout.segments[0].points.length, 1);
    assert.equal(layout.segments[1].points.length, 1);
    assert.equal(layout.points.length, 2);
    assert.equal(layout.gapTicks.length, 1);
    assert.equal(layout.gapTicks[0].state, "cloud");
    assert.equal(layout.gapTicks[0].gf, null);
  });

  it("breaks the line at a no_data day, including a day the series omitted entirely", () => {
    const layout = buildChartLayout(
      [day("2026-09-01", valid(10)), day("2026-09-02", noData()), day("2026-09-03", valid(30))],
      CONFIG,
    );
    assert.equal(layout.segments.length, 2);
    assert.equal(layout.gapTicks[0].state, "no_data");
  });

  it("breaks the line at a stale day, but still exposes its raw GF for a detail view", () => {
    const layout = buildChartLayout(
      [day("2026-09-01", valid(10)), day("2026-09-02", stale(77)), day("2026-09-03", valid(30))],
      CONFIG,
    );
    assert.equal(layout.segments.length, 2);
    assert.equal(layout.gapTicks.length, 1);
    assert.equal(layout.gapTicks[0].state, "stale");
    // The raw value is available for a tooltip/detail view...
    assert.equal(layout.gapTicks[0].gf, 77);
    // ...but it must never appear in the plotted line or point set.
    assert.equal(layout.points.some((p) => p.gf === 77), false);
  });

  it("a lone valid day between two gaps is a point, never connected by a line", () => {
    const layout = buildChartLayout(
      [day("2026-09-01", cloud()), day("2026-09-02", valid(50)), day("2026-09-03", noData())],
      CONFIG,
    );
    assert.equal(layout.points.length, 1);
    assert.equal(layout.segments.length, 1);
    assert.equal(layout.segments[0].points.length, 1);
    assert.equal(layout.gapTicks.length, 2);
  });

  it("an all-gap series plots no points and no segments, only gap ticks", () => {
    const layout = buildChartLayout(
      [day("2026-09-01", cloud()), day("2026-09-02", noData()), day("2026-09-03", stale(5))],
      CONFIG,
    );
    assert.equal(layout.points.length, 0);
    assert.equal(layout.segments.length, 0);
    assert.equal(layout.gapTicks.length, 3);
  });

  it("handles an empty series without throwing", () => {
    const layout = buildChartLayout([], CONFIG);
    assert.equal(layout.points.length, 0);
    assert.equal(layout.segments.length, 0);
    assert.equal(layout.gapTicks.length, 0);
    assert.equal(layout.xAxisTicks.length, 0);
  });
});

describe("buildChartLayout - geometry", () => {
  it("places GF 0 at the plot bottom and GF 100 at the plot top", () => {
    const layout = buildChartLayout([day("2026-09-01", valid(0)), day("2026-09-02", valid(100))], CONFIG);
    const [zero, hundred] = layout.points;
    assert.equal(zero.y, layout.plotTop + layout.plotHeight);
    assert.equal(hundred.y, layout.plotTop);
  });

  it("spreads days evenly across the plot width, first at the left edge and last at the right", () => {
    const layout = buildChartLayout(
      [day("2026-09-01", valid(10)), day("2026-09-02", valid(20)), day("2026-09-03", valid(30))],
      CONFIG,
    );
    assert.equal(layout.points[0].x, layout.plotLeft);
    assert.equal(layout.points[2].x, layout.plotLeft + layout.plotWidth);
  });

  it("centres a single-day chart's one point rather than dividing by zero", () => {
    const layout = buildChartLayout([day("2026-09-01", valid(50))], CONFIG);
    assert.equal(layout.points[0].x, layout.plotLeft + layout.plotWidth / 2);
    assert.ok(Number.isFinite(layout.points[0].x));
  });

  it("always includes five y-gridlines at 0/25/50/75/100%", () => {
    const layout = buildChartLayout([day("2026-09-01", valid(50))], CONFIG);
    assert.deepEqual(
      layout.yGridLines.map((g) => g.label),
      ["0%", "25%", "50%", "75%", "100%"],
    );
  });
});
