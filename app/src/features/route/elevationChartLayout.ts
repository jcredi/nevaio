/**
 * Pure geometry for the route elevation profile (spec section 8.4): turns a
 * profile into SVG-ready numbers, with no DOM and no drawing. `elevationChart.ts`
 * turns this into actual `<svg>` elements.
 *
 * The split mirrors `../objects/seriesChartLayout.ts`, and for the same reason:
 * the decisions that can mislead someone live in numbers that `npm test` can
 * assert, not in markup that has to be eyeballed.
 *
 * **The rule this module enforces: the y-axis never starts at zero, and always
 * says so by labelling real elevations.** An alpine profile plotted from sea
 * level would be a flat line across the top of the box - useless. Plotted from
 * its own minimum, every route looks equally dramatic, which is the opposite
 * failure: a 60 m stroll and a 1,400 m climb would draw the same shape. The
 * compromise here is a padded, rounded range with labelled gridlines, so the
 * shape is readable *and* the axis numbers tell you which of the two you are
 * looking at. Anyone changing this should keep that pairing.
 *
 * The x-axis is distance along the route in ground metres, never screen pixels
 * or zoom - spec section 8.3: "Analytical results must not change simply
 * because the user changes map zoom level."
 */
import type { ElevationPoint } from "./elevationProfile.ts";

export type ElevationChartConfig = {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
};

export const DEFAULT_ELEVATION_CHART_CONFIG: ElevationChartConfig = {
  width: 320,
  height: 110,
  padding: { top: 8, right: 6, bottom: 18, left: 34 },
};

export type ChartXY = { x: number; y: number };

export type ElevationAxisTick = { x: number; label: string };
export type ElevationGridLine = { y: number; label: string };

export type ElevationChartLayout = {
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  /** The profile as plot coordinates, in route order. */
  points: ChartXY[];
  /** `points` closed down to the plot floor, for a filled area under the line. */
  areaPoints: ChartXY[];
  xAxisTicks: ElevationAxisTick[];
  yGridLines: ElevationGridLine[];
  /** The elevation range actually drawn - padded and rounded, not the raw min/max. */
  floorMeters: number;
  ceilingMeters: number;
  totalDistanceMeters: number;
};

/** Gridline steps that read as round numbers on a mountain profile. */
const NICE_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
/** Aim for this many labelled gridlines; fewer on a short range. */
const TARGET_GRID_LINES = 4;

function niceStep(rangeMeters: number): number {
  const ideal = rangeMeters / TARGET_GRID_LINES;
  for (const step of NICE_STEPS) {
    if (step >= ideal) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

/** Kilometres once the route is long enough for them to read better than metres. */
function formatDistanceTick(meters: number, totalMeters: number): string {
  if (totalMeters < 2000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)} km`;
}

export function buildElevationChartLayout(
  profile: readonly ElevationPoint[],
  config: ElevationChartConfig = DEFAULT_ELEVATION_CHART_CONFIG,
): ElevationChartLayout | null {
  if (profile.length < 2) return null;

  const { width, height, padding } = config;
  const plotLeft = padding.left;
  const plotTop = padding.top;
  const plotWidth = Math.max(0, width - padding.left - padding.right);
  const plotHeight = Math.max(0, height - padding.top - padding.bottom);

  const startDistance = profile[0].distanceMeters;
  const totalDistanceMeters = profile[profile.length - 1].distanceMeters - startDistance;

  let minMeters = profile[0].elevationMeters;
  let maxMeters = profile[0].elevationMeters;
  for (const point of profile) {
    if (point.elevationMeters < minMeters) minMeters = point.elevationMeters;
    if (point.elevationMeters > maxMeters) maxMeters = point.elevationMeters;
  }

  const step = niceStep(Math.max(1, maxMeters - minMeters));
  // Rounded outward to whole steps so every gridline is a round number, and a
  // genuinely flat route still gets a box with height rather than a divide by
  // zero.
  const floorMeters = Math.floor(minMeters / step) * step;
  const ceilingMeters = Math.max(floorMeters + step, Math.ceil(maxMeters / step) * step);
  const span = ceilingMeters - floorMeters;

  const xFor = (distance: number): number =>
    totalDistanceMeters <= 0
      ? plotLeft + plotWidth / 2
      : plotLeft + ((distance - startDistance) / totalDistanceMeters) * plotWidth;
  const yFor = (meters: number): number =>
    plotTop + (1 - (meters - floorMeters) / span) * plotHeight;

  const points: ChartXY[] = profile.map((point) => ({
    x: xFor(point.distanceMeters),
    y: yFor(point.elevationMeters),
  }));

  const floorY = plotTop + plotHeight;
  const areaPoints: ChartXY[] = [
    { x: points[0].x, y: floorY },
    ...points,
    { x: points[points.length - 1].x, y: floorY },
  ];

  const yGridLines: ElevationGridLine[] = [];
  for (let meters = floorMeters; meters <= ceilingMeters; meters += step) {
    yGridLines.push({ y: yFor(meters), label: `${meters}` });
  }

  // Start, end, and a midpoint - enough to read the axis without crowding a
  // 320px-wide chart on a phone.
  const xAxisTicks: ElevationAxisTick[] = [
    { x: xFor(startDistance), label: formatDistanceTick(0, totalDistanceMeters) },
  ];
  if (totalDistanceMeters > 0) {
    xAxisTicks.push({
      x: xFor(startDistance + totalDistanceMeters / 2),
      label: formatDistanceTick(totalDistanceMeters / 2, totalDistanceMeters),
    });
    xAxisTicks.push({
      x: xFor(startDistance + totalDistanceMeters),
      label: formatDistanceTick(totalDistanceMeters, totalDistanceMeters),
    });
  }

  return {
    width,
    height,
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    points,
    areaPoints,
    xAxisTicks,
    yGridLines,
    floorMeters,
    ceilingMeters,
    totalDistanceMeters,
  };
}

/**
 * The distance along the route that a plot x-coordinate refers to, for spec
 * section 8.5's linked interaction. Clamped to the route, so a finger dragged
 * past either end of the chart reads that end rather than nothing.
 */
export function distanceForX(layout: ElevationChartLayout, x: number): number {
  if (layout.plotWidth <= 0) return 0;
  const fraction = (x - layout.plotLeft) / layout.plotWidth;
  const clamped = Math.min(1, Math.max(0, fraction));
  return clamped * layout.totalDistanceMeters;
}

/** The inverse, for placing the cursor line at a known distance. */
export function xForDistance(layout: ElevationChartLayout, distanceMeters: number): number {
  if (layout.totalDistanceMeters <= 0) return layout.plotLeft + layout.plotWidth / 2;
  const fraction = distanceMeters / layout.totalDistanceMeters;
  const clamped = Math.min(1, Math.max(0, fraction));
  return layout.plotLeft + clamped * layout.plotWidth;
}
