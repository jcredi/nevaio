/**
 * Pure geometry for the snow-history chart (spec section 7.1): turns one
 * calendar day's worth of decoded cells into SVG-ready numbers, with no DOM
 * and no drawing. `historyChart.ts` turns this into actual `<svg>` elements;
 * keeping the geometry here means the one rule that matters most - honesty
 * about gaps - is asserted by `npm test`, not just eyeballed in a browser.
 *
 * **The rule, mechanically enforced here**: a line segment connects two
 * `valid` marks only when they are *immediately adjacent calendar days*, both
 * `valid`. Any other state in between - `cloud`, `no_data`, `stale`, or a day
 * this input simply omits - ends the segment. There is no code path that
 * draws a line across a gap, carries a value forward, or turns a gap into a
 * y=0 point: gaps get their own `gapTicks`, entirely separate from the
 * plotted line, and a `stale` tick still carries its raw `gf` for a detail
 * view (mirroring `object_series.py`: "the raw GF/QA are kept for detail
 * views, but this is a gap, not a mark") while never entering `points` or
 * `segments`.
 *
 * `days` must be one entry per *consecutive* calendar day with no calendar
 * gaps of its own - `seriesClient.ts` is responsible for that (a day with no
 * data at all is a `no_data` cell, never a missing array entry), which is
 * what lets this module treat "adjacent in the array" and "adjacent on the
 * calendar" as the same thing without parsing dates itself.
 *
 * Pure and dependency-free: `npm test` runs this directly under Node.
 */
import type { SeriesCell, SeriesMarkState } from "./seriesFormat.ts";

export type DayCell = { date: string; cell: SeriesCell };

export type ChartConfig = {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
};

export const DEFAULT_CHART_CONFIG: ChartConfig = {
  width: 320,
  height: 140,
  padding: { top: 10, right: 10, bottom: 22, left: 28 },
};

export type ChartPoint = {
  x: number;
  y: number;
  date: string;
  gf: number;
  quality: number | null;
  ageDays: number | null;
};

export type LineSegment = { points: ChartPoint[] };

/** A day that is a gap, positioned in the plot but never given a y-value. */
export type GapTick = {
  x: number;
  date: string;
  state: Exclude<SeriesMarkState, "valid">;
  /** Only `stale` carries a raw value, and only for a detail view - never plotted. */
  gf: number | null;
};

export type AxisTick = { x: number; label: string };
export type GridLine = { y: number; label: string };

export type ChartLayout = {
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  /** Baseline y for gap ticks - just under the plot, never inside the value area. */
  gapTickY: number;
  segments: LineSegment[];
  points: ChartPoint[];
  gapTicks: GapTick[];
  xAxisTicks: AxisTick[];
  yGridLines: GridLine[];
};

const Y_GRID_VALUES = [0, 25, 50, 75, 100];

/** Roughly this many labelled x-axis ticks, whatever the period length. */
const TARGET_TICK_COUNT = 6;

function shortLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** x for the i-th of n days. A single-day chart centres its one point. */
function xFor(index: number, n: number, plotLeft: number, plotWidth: number): number {
  if (n <= 1) return plotLeft + plotWidth / 2;
  return plotLeft + (index / (n - 1)) * plotWidth;
}

function yFor(gf: number, plotTop: number, plotHeight: number): number {
  const clamped = Math.min(100, Math.max(0, gf));
  return plotTop + (1 - clamped / 100) * plotHeight;
}

export function buildChartLayout(days: readonly DayCell[], config: ChartConfig = DEFAULT_CHART_CONFIG): ChartLayout {
  const { width, height, padding } = config;
  const plotLeft = padding.left;
  const plotTop = padding.top;
  const plotWidth = Math.max(0, width - padding.left - padding.right);
  const plotHeight = Math.max(0, height - padding.top - padding.bottom);
  const gapTickY = plotTop + plotHeight + 6;

  const n = days.length;
  const segments: LineSegment[] = [];
  const points: ChartPoint[] = [];
  const gapTicks: GapTick[] = [];

  let current: ChartPoint[] = [];
  let previousValid = false;

  for (let i = 0; i < n; i += 1) {
    const { date, cell } = days[i];
    const x = xFor(i, n, plotLeft, plotWidth);

    if (cell.state === "valid" && cell.gf !== null) {
      const point: ChartPoint = {
        x,
        y: yFor(cell.gf, plotTop, plotHeight),
        date,
        gf: cell.gf,
        quality: cell.quality,
        ageDays: cell.ageDays,
      };
      points.push(point);
      if (previousValid) {
        current.push(point);
      } else {
        if (current.length > 0) segments.push({ points: current });
        current = [point];
      }
      previousValid = true;
    } else {
      if (current.length > 0) segments.push({ points: current });
      current = [];
      previousValid = false;
      // Not `valid` here: either the state itself is a gap state, or (in
      // principle only - the decoder never produces this) `valid` with a
      // null `gf`. Either way it is not plottable, which is what matters.
      gapTicks.push({
        x,
        date,
        state: cell.state as Exclude<SeriesMarkState, "valid">,
        gf: cell.state === "stale" ? cell.gf : null,
      });
    }
  }
  if (current.length > 0) segments.push({ points: current });

  const tickStride = Math.max(1, Math.ceil(n / TARGET_TICK_COUNT));
  const xAxisTicks: AxisTick[] = [];
  for (let i = 0; i < n; i += tickStride) {
    xAxisTicks.push({ x: xFor(i, n, plotLeft, plotWidth), label: shortLabel(days[i].date) });
  }
  // Always label the last day too, unless the stride already lands on it.
  if (n > 0 && (n - 1) % tickStride !== 0) {
    xAxisTicks.push({ x: xFor(n - 1, n, plotLeft, plotWidth), label: shortLabel(days[n - 1].date) });
  }

  const yGridLines: GridLine[] = Y_GRID_VALUES.map((value) => ({
    y: yFor(value, plotTop, plotHeight),
    label: `${value}%`,
  }));

  return {
    width,
    height,
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    gapTickY,
    segments,
    points,
    gapTicks,
    xAxisTicks,
    yGridLines,
  };
}
