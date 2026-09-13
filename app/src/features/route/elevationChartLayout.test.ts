/**
 * Tests for the elevation chart's pure geometry (spec section 8.4).
 *
 * The rule worth asserting is the y-axis compromise described in the module:
 * the axis does not start at zero (an alpine profile from sea level is a flat
 * line), but it is always labelled with real rounded elevations, so a 60 m
 * stroll and a 1,400 m climb can be told apart despite drawing a similar shape.
 * Both halves of that pairing are checked here.
 *
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ELEVATION_CHART_CONFIG,
  buildElevationChartLayout,
  distanceForX,
  xForDistance,
} from "./elevationChartLayout.ts";
import type { ElevationPoint } from "./elevationProfile.ts";

function profile(pairs: [number, number][]): ElevationPoint[] {
  return pairs.map(([distanceMeters, elevationMeters]) => ({ distanceMeters, elevationMeters }));
}

const climb = profile([
  [0, 1608],
  [1000, 1750],
  [2000, 1900],
  [3843, 2021],
]);

describe("buildElevationChartLayout", () => {
  it("returns null for a profile too short to draw", () => {
    assert.equal(buildElevationChartLayout([]), null);
    assert.equal(buildElevationChartLayout(profile([[0, 1000]])), null);
  });

  it("keeps every point inside the plot box", () => {
    const layout = buildElevationChartLayout(climb);
    assert.ok(layout !== null);
    for (const point of layout.points) {
      assert.ok(point.x >= layout.plotLeft - 1e-9 && point.x <= layout.plotLeft + layout.plotWidth + 1e-9);
      assert.ok(point.y >= layout.plotTop - 1e-9 && point.y <= layout.plotTop + layout.plotHeight + 1e-9);
    }
  });

  it("does not start the y-axis at zero", () => {
    const layout = buildElevationChartLayout(climb);
    assert.ok(layout !== null);
    // Anchoring at sea level would flatten an alpine profile into a line.
    assert.ok(layout.floorMeters > 1000, `floor was ${layout.floorMeters}`);
    assert.ok(layout.floorMeters <= 1608);
    assert.ok(layout.ceilingMeters >= 2021);
  });

  it("labels the axis with round numbers that bracket the real range", () => {
    const layout = buildElevationChartLayout(climb);
    assert.ok(layout !== null);
    const labels = layout.yGridLines.map((line) => Number(line.label));
    assert.ok(labels.length >= 2, "an axis needs at least two labelled lines");
    assert.equal(labels[0], layout.floorMeters);
    assert.equal(labels[labels.length - 1], layout.ceilingMeters);
    const step = labels[1] - labels[0];
    for (const [i, value] of labels.entries()) {
      assert.equal(value, layout.floorMeters + i * step, "gridlines must be evenly spaced");
      assert.equal(value % step, 0, "every gridline label must be a round multiple of the step");
    }
  });

  it("distinguishes a gentle route from a big climb by its axis, not its shape", () => {
    // Both draw a similar line; only the labels say which is which. That is
    // the whole compromise, so it is asserted rather than assumed.
    const gentle = buildElevationChartLayout(profile([[0, 1200], [500, 1230], [1000, 1260]]));
    const big = buildElevationChartLayout(profile([[0, 1200], [5000, 1900], [10000, 2600]]));
    assert.ok(gentle !== null && big !== null);
    assert.ok(
      big.ceilingMeters - big.floorMeters > (gentle.ceilingMeters - gentle.floorMeters) * 5,
      "the labelled span must reflect the real climb",
    );
  });

  it("survives a perfectly flat profile without dividing by zero", () => {
    const layout = buildElevationChartLayout(profile([[0, 1500], [1000, 1500], [2000, 1500]]));
    assert.ok(layout !== null);
    assert.ok(layout.ceilingMeters > layout.floorMeters, "a flat route still needs a box with height");
    for (const point of layout.points) assert.ok(Number.isFinite(point.y));
  });

  it("survives a zero-length profile", () => {
    const layout = buildElevationChartLayout(profile([[0, 1500], [0, 1520]]));
    assert.ok(layout !== null);
    for (const point of layout.points) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  });

  it("closes the filled area down to the plot floor", () => {
    const layout = buildElevationChartLayout(climb);
    assert.ok(layout !== null);
    const floorY = layout.plotTop + layout.plotHeight;
    assert.equal(layout.areaPoints[0].y, floorY);
    assert.equal(layout.areaPoints[layout.areaPoints.length - 1].y, floorY);
    assert.equal(layout.areaPoints.length, layout.points.length + 2);
  });

  it("labels distance in metres when short and kilometres when long", () => {
    const short = buildElevationChartLayout(profile([[0, 1000], [900, 1100]]));
    const long = buildElevationChartLayout(climb);
    assert.ok(short !== null && long !== null);
    assert.ok(short.xAxisTicks.every((t) => t.label.endsWith(" m")));
    assert.ok(long.xAxisTicks.every((t) => t.label.endsWith(" km")));
  });

  it("uses the configured box", () => {
    const layout = buildElevationChartLayout(climb);
    assert.ok(layout !== null);
    assert.equal(layout.width, DEFAULT_ELEVATION_CHART_CONFIG.width);
    assert.equal(layout.height, DEFAULT_ELEVATION_CHART_CONFIG.height);
  });
});

describe("distanceForX / xForDistance", () => {
  it("round-trip within the plot", () => {
    const layout = buildElevationChartLayout(climb);
    assert.ok(layout !== null);
    for (const fraction of [0, 0.25, 0.5, 1]) {
      const distance = fraction * layout.totalDistanceMeters;
      const back = distanceForX(layout, xForDistance(layout, distance));
      assert.ok(Math.abs(back - distance) < 1e-6, `round trip failed at ${distance}`);
    }
  });

  it("clamps a pointer dragged past either edge to the route's ends", () => {
    const layout = buildElevationChartLayout(climb);
    assert.ok(layout !== null);
    assert.equal(distanceForX(layout, -9999), 0);
    assert.equal(distanceForX(layout, 9999), layout.totalDistanceMeters);
  });
});
