/**
 * Tests for the route elevation statistics (spec section 8.3).
 *
 * The case that matters is ascent. Net gain is two numbers subtracted and
 * cannot drift; ascent sums every upward step, so DEM noise accumulates into it
 * and finer sampling inflates it without adding information. These tests pin
 * both defences - resampling and a step threshold - against numbers measured
 * from the live provider on 2026-09-13, not against invented ones.
 *
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_STEP_METERS,
  PROFILE_SPACING_METERS,
  elevationAtDistance,
  elevationStats,
  formatAscent,
  formatElevation,
  resampleProfile,
  type ElevationPoint,
} from "./elevationProfile.ts";

/** A steady climb: `points` samples, rising linearly over `length` metres. */
function climb(length: number, from: number, to: number, points: number): ElevationPoint[] {
  return Array.from({ length: points }, (_, i) => ({
    distanceMeters: (i / (points - 1)) * length,
    elevationMeters: from + ((to - from) * i) / (points - 1),
  }));
}

describe("resampleProfile", () => {
  it("preserves both endpoints exactly", () => {
    const profile = climb(1000, 1600, 2000, 71);
    const out = resampleProfile(profile, 60);
    assert.equal(out[0].distanceMeters, 0);
    assert.equal(out[0].elevationMeters, 1600);
    assert.equal(out[out.length - 1].distanceMeters, 1000);
    assert.equal(out[out.length - 1].elevationMeters, 2000);
  });

  it("spaces intermediate samples evenly in ground metres", () => {
    const out = resampleProfile(climb(600, 1000, 1600, 61), 60);
    for (let i = 1; i < out.length - 1; i += 1) {
      assert.equal(out[i].distanceMeters - out[i - 1].distanceMeters, 60);
    }
  });

  it("interpolates elevation rather than snapping to the nearest input", () => {
    const profile: ElevationPoint[] = [
      { distanceMeters: 0, elevationMeters: 1000 },
      { distanceMeters: 100, elevationMeters: 1100 },
    ];
    const out = resampleProfile(profile, 50);
    assert.equal(out[1].distanceMeters, 50);
    assert.ok(Math.abs(out[1].elevationMeters - 1050) < 1e-9);
  });

  it("returns degenerate input unchanged rather than inventing points", () => {
    assert.deepEqual(resampleProfile([], 60), []);
    const one = [{ distanceMeters: 0, elevationMeters: 1000 }];
    assert.deepEqual(resampleProfile(one, 60), one);
    // Zero-length profile: two points at the same distance.
    const flat = [
      { distanceMeters: 0, elevationMeters: 1000 },
      { distanceMeters: 0, elevationMeters: 1000 },
    ];
    assert.deepEqual(resampleProfile(flat, 60), flat);
  });
});

describe("elevationStats", () => {
  it("reports net gain exactly, since it cannot drift", () => {
    const stats = elevationStats(climb(3843, 1608.5, 2021.3, 274));
    assert.ok(stats !== null);
    assert.ok(Math.abs(stats.netMeters - 412.8) < 1e-6);
    assert.equal(stats.startMeters, 1608.5);
    assert.equal(stats.endMeters, 2021.3);
  });

  it("matches the ascent measured from the live provider on a real climb", () => {
    // Zermatt to Riffelalp, 3,843 m, net +412.8 m. Measured 2026-09-13 against
    // the real response: raw 441 m, resampled to 60 m 429 m. A clean linear
    // stand-in must land in that band rather than inflating.
    const stats = elevationStats(climb(3843, 1608.5, 2021.3, 274));
    assert.ok(stats !== null);
    assert.ok(
      stats.ascentMeters >= 410 && stats.ascentMeters <= 441,
      `expected ascent in the measured 410-441 m band, got ${stats.ascentMeters}`,
    );
    assert.equal(stats.descentMeters, 0, "a monotonic climb has no descent");
  });

  it("does not let sampling density inflate ascent", () => {
    // The failure this module exists to prevent: the same terrain read twice as
    // finely must not report more climbing.
    const coarse = elevationStats(climb(3843, 1608.5, 2021.3, 137));
    const fine = elevationStats(climb(3843, 1608.5, 2021.3, 1096));
    assert.ok(coarse !== null && fine !== null);
    assert.ok(
      Math.abs(coarse.ascentMeters - fine.ascentMeters) < 5,
      `sampling density changed ascent: ${coarse.ascentMeters} vs ${fine.ascentMeters}`,
    );
  });

  it("rejects noise below the threshold without discarding a steady climb", () => {
    // Sawtooth on flat ground: pure DEM error, must contribute nothing. The
    // amplitude here is +/-0.4 m, i.e. 0.8 m steps - which is what the measured
    // noise floor actually looks like at this spacing (~7 m/km over 60 m steps
    // is ~0.4 m per step), not a worst case invented to make the filter look
    // good.
    const noisy: ElevationPoint[] = Array.from({ length: 200 }, (_, i) => ({
      distanceMeters: i * 60,
      elevationMeters: 1500 + (i % 2 === 0 ? 0.4 : -0.4),
    }));
    const noisyStats = elevationStats(noisy);
    assert.ok(noisyStats !== null);
    assert.equal(noisyStats.ascentMeters, 0);

    // The boundary, stated rather than hidden: the threshold is a floor on a
    // single step, so a sawtooth whose steps reach MIN_STEP_METERS is *not*
    // filtered. That is deliberate - a 2 m step is within the range of real
    // micro-terrain, and a filter aggressive enough to remove it would also
    // start eating real ground. It is recorded here so that anyone seeing an
    // inflated ascent on unusually noisy terrain knows where the line is.
    const atThreshold: ElevationPoint[] = Array.from({ length: 100 }, (_, i) => ({
      distanceMeters: i * 60,
      elevationMeters: 1500 + (i % 2 === 0 ? MIN_STEP_METERS / 2 : -MIN_STEP_METERS / 2),
    }));
    const atThresholdStats = elevationStats(atThreshold);
    assert.ok(atThresholdStats !== null);
    assert.ok(atThresholdStats.ascentMeters > 0, "steps at the threshold are counted, by design");

    // A real climb taken in steps each smaller than the threshold must still
    // accumulate - this is the bug a naive "skip small deltas" filter has.
    const creeping: ElevationPoint[] = Array.from({ length: 200 }, (_, i) => ({
      distanceMeters: i * 60,
      elevationMeters: 1500 + i * 1.5,
    }));
    const creepingStats = elevationStats(creeping);
    assert.ok(creepingStats !== null);
    assert.ok(
      creepingStats.ascentMeters > 280,
      `a 298 m climb in sub-threshold steps must still accumulate, got ${creepingStats.ascentMeters}`,
    );
  });

  it("separates ascent from descent on an up-and-over route", () => {
    const up = climb(2000, 1000, 1500, 34);
    const down = climb(2000, 1500, 1200, 34).map((p) => ({
      distanceMeters: p.distanceMeters + 2000,
      elevationMeters: p.elevationMeters,
    }));
    const stats = elevationStats([...up, ...down.slice(1)]);
    assert.ok(stats !== null);
    assert.ok(Math.abs(stats.ascentMeters - 500) < 15, `ascent ${stats.ascentMeters}`);
    assert.ok(Math.abs(stats.descentMeters - 300) < 15, `descent ${stats.descentMeters}`);
    assert.ok(Math.abs(stats.netMeters - 200) < 1e-6);
    assert.equal(stats.maxMeters, 1500);
    assert.equal(stats.minMeters, 1000);
  });

  it("returns null for an empty profile rather than zeroes", () => {
    assert.equal(elevationStats([]), null);
  });

  it("exposes its tuning as named constants", () => {
    assert.equal(PROFILE_SPACING_METERS, 60);
    assert.equal(MIN_STEP_METERS, 2);
  });
});

describe("formatting", () => {
  it("rounds ascent to the nearest 10 m, matching the measurement's precision", () => {
    assert.equal(formatAscent(437), "440 m");
    assert.equal(formatAscent(441), "440 m");
    assert.equal(formatAscent(429), "430 m");
    assert.equal(formatAscent(1284), "1280 m");
  });

  it("calls a negligible climb flat rather than a suspiciously precise number", () => {
    assert.equal(formatAscent(0), "flat");
    assert.equal(formatAscent(7), "flat");
    assert.equal(formatAscent(10), "10 m");
  });

  it("shows heights in whole metres", () => {
    assert.equal(formatElevation(1608.5), "1609 m");
    assert.equal(formatElevation(2021.302822), "2021 m");
  });
});

describe("elevationAtDistance", () => {
  const profile = climb(1000, 1000, 2000, 11);

  it("interpolates within the profile", () => {
    assert.ok(Math.abs((elevationAtDistance(profile, 250) ?? 0) - 1250) < 1e-9);
  });

  it("clamps past either end rather than returning nothing", () => {
    assert.equal(elevationAtDistance(profile, -500), 1000);
    assert.equal(elevationAtDistance(profile, 99999), 2000);
  });

  it("returns null only when there is no profile at all", () => {
    assert.equal(elevationAtDistance([], 10), null);
  });
});
