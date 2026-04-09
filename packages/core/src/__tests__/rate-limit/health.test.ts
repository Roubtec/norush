import { describe, expect, it } from "vitest";
import { computeHealth, computeEffectiveLimit } from "../../rate-limit/health.js";
import type { SlidingWindow, HealthScore } from "../../types.js";

// ---------------------------------------------------------------------------
// computeHealth
// ---------------------------------------------------------------------------

describe("computeHealth", () => {
  it("returns healthy (factor 1.0) when window is empty", () => {
    const window: SlidingWindow = { total: 0, succeeded: 0, failed: 0 };
    const result = computeHealth(window);
    expect(result).toEqual({ factor: 1.0, reason: "healthy" });
  });

  it("returns healthy (factor 1.0) when success rate >= 0.9", () => {
    // Exactly 90%
    const window90: SlidingWindow = { total: 10, succeeded: 9, failed: 1 };
    expect(computeHealth(window90)).toEqual({ factor: 1.0, reason: "healthy" });

    // 100%
    const window100: SlidingWindow = { total: 5, succeeded: 5, failed: 0 };
    expect(computeHealth(window100)).toEqual({ factor: 1.0, reason: "healthy" });

    // 95%
    const window95: SlidingWindow = { total: 20, succeeded: 19, failed: 1 };
    expect(computeHealth(window95)).toEqual({ factor: 1.0, reason: "healthy" });
  });

  it("returns partial_failures (factor 0.5) when success rate >= 0.5 and < 0.9", () => {
    // Exactly 50%
    const window50: SlidingWindow = { total: 10, succeeded: 5, failed: 5 };
    expect(computeHealth(window50)).toEqual({ factor: 0.5, reason: "partial_failures" });

    // 89% (just below healthy threshold)
    const window89: SlidingWindow = { total: 100, succeeded: 89, failed: 11 };
    expect(computeHealth(window89)).toEqual({ factor: 0.5, reason: "partial_failures" });

    // 70%
    const window70: SlidingWindow = { total: 10, succeeded: 7, failed: 3 };
    expect(computeHealth(window70)).toEqual({ factor: 0.5, reason: "partial_failures" });
  });

  it("returns mostly_failing (factor 0.25) when success rate > 0 and < 0.5", () => {
    // 49% (just below partial_failures threshold)
    const window49: SlidingWindow = { total: 100, succeeded: 49, failed: 51 };
    expect(computeHealth(window49)).toEqual({ factor: 0.25, reason: "mostly_failing" });

    // 10%
    const window10: SlidingWindow = { total: 10, succeeded: 1, failed: 9 };
    expect(computeHealth(window10)).toEqual({ factor: 0.25, reason: "mostly_failing" });

    // 1 out of 100
    const window1: SlidingWindow = { total: 100, succeeded: 1, failed: 99 };
    expect(computeHealth(window1)).toEqual({ factor: 0.25, reason: "mostly_failing" });
  });

  it("returns critical (factor 0.1) when success rate is 0", () => {
    const window: SlidingWindow = { total: 10, succeeded: 0, failed: 10 };
    expect(computeHealth(window)).toEqual({ factor: 0.1, reason: "critical" });
  });

  it("returns critical (factor 0.1) when all batches failed with just 1 total", () => {
    const window: SlidingWindow = { total: 1, succeeded: 0, failed: 1 };
    expect(computeHealth(window)).toEqual({ factor: 0.1, reason: "critical" });
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveLimit
// ---------------------------------------------------------------------------

describe("computeEffectiveLimit", () => {
  it("returns full base limit when healthy", () => {
    const health: HealthScore = { factor: 1.0, reason: "healthy" };
    expect(computeEffectiveLimit(100, health)).toBe(100);
  });

  it("returns half base limit when partial_failures", () => {
    const health: HealthScore = { factor: 0.5, reason: "partial_failures" };
    expect(computeEffectiveLimit(100, health)).toBe(50);
  });

  it("returns quarter base limit when mostly_failing", () => {
    const health: HealthScore = { factor: 0.25, reason: "mostly_failing" };
    expect(computeEffectiveLimit(100, health)).toBe(25);
  });

  it("returns 10% of base limit when critical", () => {
    const health: HealthScore = { factor: 0.1, reason: "critical" };
    expect(computeEffectiveLimit(100, health)).toBe(10);
  });

  it("guarantees minimum of 1 even at critical with small base", () => {
    const health: HealthScore = { factor: 0.1, reason: "critical" };
    // 0.1 * 5 = 0.5, floored to 0, but min is 1
    expect(computeEffectiveLimit(5, health)).toBe(1);
  });

  it("guarantees minimum of 1 even at critical with base of 1", () => {
    const health: HealthScore = { factor: 0.1, reason: "critical" };
    // 0.1 * 1 = 0.1, floored to 0, but min is 1
    expect(computeEffectiveLimit(1, health)).toBe(1);
  });

  it("floors fractional results", () => {
    const health: HealthScore = { factor: 0.5, reason: "partial_failures" };
    // 0.5 * 7 = 3.5, floored to 3
    expect(computeEffectiveLimit(7, health)).toBe(3);
  });

  it("handles base limit of 0 with minimum guarantee", () => {
    const health: HealthScore = { factor: 1.0, reason: "healthy" };
    // Even at full health, if base is 0, minimum throughput of 1 applies
    expect(computeEffectiveLimit(0, health)).toBe(1);
  });
});
