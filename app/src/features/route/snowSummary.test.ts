/**
 * Tests for the route snow summary (spec section 8.4).
 *
 * Almost all of these are one rule seen from different angles: an unobserved
 * sample must never be counted as a sample with no snow. Spec section 5.4 -
 * "The application must not confuse unavailable observations with 0% snow" -
 * and a summary statistic is the easiest place in the app to break it, because
 * dividing by the wrong denominator makes a route look *safer* the worse the
 * data is.
 *
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_COVERAGE_FOR_HEADLINE,
  SNOW_THRESHOLD_PERCENT,
  snowHeadline,
  summariseSnow,
} from "./snowSummary.ts";
import { SnowDataState, type SnowDataCell } from "./snowDataTile.ts";

function observed(fsc: number, options: { age?: number; quality?: number } = {}): SnowDataCell {
  return {
    fsc,
    ageDays: options.age ?? 0,
    quality: options.quality ?? 0,
    state: SnowDataState.Valid,
  };
}

function missing(state: SnowDataState): SnowDataCell {
  return { fsc: null, ageDays: null, quality: null, state };
}

describe("summariseSnow", () => {
  it("divides by observed samples, not by all of them", () => {
    // Half the route is cloud; of what was seen, all of it is snow. The honest
    // answer is 100% of the observed route, with coverage 0.5 - not 50%.
    const cells = [observed(100), observed(100), missing(SnowDataState.Cloud), missing(SnowDataState.Cloud)];
    const summary = summariseSnow(cells);
    assert.equal(summary.observedSamples, 2);
    assert.equal(summary.totalSamples, 4);
    assert.equal(summary.coverage, 0.5);
    assert.equal(summary.snowFraction, 1);
    assert.equal(summary.meanCoverPercent, 100);
  });

  it("reports null rather than zero when nothing was observed", () => {
    const summary = summariseSnow([
      missing(SnowDataState.Cloud),
      missing(SnowDataState.NoData),
      missing(SnowDataState.Water),
    ]);
    assert.equal(summary.observedSamples, 0);
    // Zero here would read as "no snow", which is the exact confusion spec 5.4
    // forbids. Null is "we do not know".
    assert.equal(summary.snowFraction, null);
    assert.equal(summary.meanCoverPercent, null);
    assert.equal(summary.coverage, 0);
  });

  it("counts a confirmed 0% as an observation of no snow", () => {
    // The other half of the same rule: 0% is data, and must not be discarded
    // as though it were an absence.
    const summary = summariseSnow([observed(0), observed(0)]);
    assert.equal(summary.observedSamples, 2);
    assert.equal(summary.snowFraction, 0);
    assert.equal(summary.meanCoverPercent, 0);
    assert.equal(summary.coverage, 1);
  });

  it("applies the threshold at its boundary", () => {
    const below = summariseSnow([observed(SNOW_THRESHOLD_PERCENT - 1)]);
    const at = summariseSnow([observed(SNOW_THRESHOLD_PERCENT)]);
    assert.equal(below.snowFraction, 0);
    assert.equal(at.snowFraction, 1);
  });

  it("does not join two snowy stretches across an unobserved gap", () => {
    // Claiming one continuous snowfield across a cloud bank would be inventing
    // the part nobody saw.
    const cells = [
      observed(90),
      observed(90),
      missing(SnowDataState.Cloud),
      observed(90),
      observed(90),
      observed(90),
    ];
    const summary = summariseSnow(cells);
    assert.equal(summary.longestSnowRun, 3);
  });

  it("breaks a run on a genuine bare stretch too", () => {
    const summary = summariseSnow([observed(90), observed(0), observed(90), observed(90)]);
    assert.equal(summary.longestSnowRun, 2);
  });

  it("reports the worst freshness and quality, not the average", () => {
    // Spec 15 item 11 wants these prominent. An average would hide the one
    // stretch that is a fortnight stale behind a lot of fresh data.
    const summary = summariseSnow([
      observed(80, { age: 0, quality: 0 }),
      observed(80, { age: 12, quality: 3 }),
      observed(80, { age: 2, quality: 1 }),
    ]);
    assert.equal(summary.maxAgeDays, 12);
    assert.equal(summary.worstQuality, 3);
  });

  it("counts every state so nothing is silently dropped", () => {
    const summary = summariseSnow([
      observed(10),
      missing(SnowDataState.Cloud),
      missing(SnowDataState.Water),
      missing(SnowDataState.NoData),
      missing(SnowDataState.Stale),
    ]);
    assert.equal(summary.stateCounts[SnowDataState.Valid], 1);
    assert.equal(summary.stateCounts[SnowDataState.Cloud], 1);
    assert.equal(summary.stateCounts[SnowDataState.Water], 1);
    assert.equal(summary.stateCounts[SnowDataState.NoData], 1);
    assert.equal(summary.stateCounts[SnowDataState.Stale], 1);
    const total = Object.values(summary.stateCounts).reduce((a, b) => a + b, 0);
    assert.equal(total, summary.totalSamples);
  });

  it("handles an empty route without dividing by zero", () => {
    const summary = summariseSnow([]);
    assert.equal(summary.totalSamples, 0);
    assert.equal(summary.coverage, 0);
    assert.equal(summary.snowFraction, null);
    assert.equal(summary.longestSnowRun, 0);
  });
});

describe("snowHeadline", () => {
  it("states a figure when most of the route was observed", () => {
    const cells = [observed(90), observed(90), observed(0), observed(0)];
    assert.equal(snowHeadline(summariseSnow(cells)), "About 50% of the observed route is snow-covered");
  });

  it("says so plainly when the observed route has no snow", () => {
    assert.equal(snowHeadline(summariseSnow([observed(0), observed(5)])), "No snow on the observed parts of this route");
  });

  it("refuses a headline when too little of the route was observed", () => {
    // A confident percentage from a tenth of the route is worse than admitting
    // the route is mostly unobserved.
    const cells = [observed(90), ...Array.from({ length: 9 }, () => missing(SnowDataState.Cloud))];
    const summary = summariseSnow(cells);
    assert.ok(summary.coverage < MIN_COVERAGE_FOR_HEADLINE);
    assert.equal(snowHeadline(summary), null);
  });

  it("refuses a headline when nothing was observed at all", () => {
    assert.equal(snowHeadline(summariseSnow([missing(SnowDataState.NoData)])), null);
  });
});
