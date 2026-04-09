import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  buildRateLimitHeaders,
  nextPeriodReset,
  DEFAULT_PERIOD_MS,
} from "../../rate-limit/limiter.js";
import type { SlidingWindow, UserLimits } from "../../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2025-06-01T12:00:00Z");

function makeUserLimits(overrides: Partial<UserLimits> = {}): UserLimits {
  return {
    userId: "user_01",
    maxRequestsPerHour: 100,
    maxTokensPerDay: 1_000_000,
    hardSpendLimitUsd: 50.0,
    currentPeriodRequests: 0,
    currentPeriodTokens: 0,
    currentSpendUsd: 0,
    periodResetAt: new Date(NOW.getTime() + 1_800_000), // 30 min from now
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    ...overrides,
  };
}

const HEALTHY_WINDOW: SlidingWindow = { total: 10, succeeded: 10, failed: 0 };
const DEGRADED_WINDOW: SlidingWindow = { total: 10, succeeded: 7, failed: 3 };
const CRITICAL_WINDOW: SlidingWindow = { total: 10, succeeded: 0, failed: 10 };
const EMPTY_WINDOW: SlidingWindow = { total: 0, succeeded: 0, failed: 0 };

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe("checkRateLimit", () => {
  describe("when no limits are configured", () => {
    it("allows the request", () => {
      const result = checkRateLimit(null, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });

    it("still computes health score", () => {
      const result = checkRateLimit(null, DEGRADED_WINDOW, NOW);
      expect(result.health?.reason).toBe("partial_failures");
    });
  });

  describe("hard spend limit", () => {
    it("rejects when cumulative spend reaches the limit", () => {
      const limits = makeUserLimits({
        hardSpendLimitUsd: 50.0,
        currentSpendUsd: 50.0,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("hard_spend_limit_exceeded");
    });

    it("rejects when cumulative spend exceeds the limit", () => {
      const limits = makeUserLimits({
        hardSpendLimitUsd: 50.0,
        currentSpendUsd: 75.0,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("hard_spend_limit_exceeded");
    });

    it("allows when spend is below the limit", () => {
      const limits = makeUserLimits({
        hardSpendLimitUsd: 50.0,
        currentSpendUsd: 49.99,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });

    it("allows when hard spend limit is null (unlimited)", () => {
      const limits = makeUserLimits({
        hardSpendLimitUsd: null,
        currentSpendUsd: 1_000_000,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });
  });

  describe("request limit enforcement", () => {
    it("allows when below the effective limit", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 50,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });

    it("rejects when at the effective limit", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 100,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("request_limit_exceeded");
    });

    it("rejects when above the effective limit", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 150,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("request_limit_exceeded");
    });

    it("applies health factor to effective limit", () => {
      // Degraded health (factor 0.5) -> effective limit = 50
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 50,
      });
      const result = checkRateLimit(limits, DEGRADED_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("request_limit_exceeded");
      expect(result.effectiveLimit).toBe(50);
    });

    it("allows when below health-adjusted limit", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 49,
      });
      const result = checkRateLimit(limits, DEGRADED_WINDOW, NOW);
      expect(result.allowed).toBe(true);
      expect(result.effectiveLimit).toBe(50);
    });

    it("provides retry-after seconds", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 100,
        periodResetAt: new Date(NOW.getTime() + 600_000), // 10 min from now
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBe(600);
    });

    it("allows when max_requests_per_hour is null (unlimited)", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: null,
        currentPeriodRequests: 999_999,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });
  });

  describe("token limit enforcement", () => {
    it("rejects when token limit is exceeded", () => {
      const limits = makeUserLimits({
        maxTokensPerDay: 1_000_000,
        currentPeriodTokens: 1_000_000,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("token_limit_exceeded");
    });

    it("allows when below token limit", () => {
      const limits = makeUserLimits({
        maxTokensPerDay: 1_000_000,
        currentPeriodTokens: 999_999,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });

    it("allows when token limit is null (unlimited)", () => {
      const limits = makeUserLimits({
        maxTokensPerDay: null,
        currentPeriodTokens: 999_999_999,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });
  });

  describe("period reset behavior", () => {
    it("treats counters as 0 when period has expired", () => {
      const pastReset = new Date(NOW.getTime() - 1000); // 1 second ago
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 200,
        periodResetAt: pastReset,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });

    it("treats token counters as 0 when period has expired", () => {
      const pastReset = new Date(NOW.getTime() - 1000);
      const limits = makeUserLimits({
        maxTokensPerDay: 100,
        currentPeriodTokens: 500,
        periodResetAt: pastReset,
      });
      const result = checkRateLimit(limits, HEALTHY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
    });
  });

  describe("minimum throughput guarantee at critical health", () => {
    it("allows at least 1 request even at critical health", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 0,
      });
      // Critical: factor 0.1 -> effective = max(floor(100*0.1), 1) = 10
      const result = checkRateLimit(limits, CRITICAL_WINDOW, NOW);
      expect(result.allowed).toBe(true);
      expect(result.effectiveLimit).toBe(10);
    });

    it("allows 1 request with small base limit at critical health", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 5,
        currentPeriodRequests: 0,
      });
      // Critical: factor 0.1 -> effective = max(floor(5*0.1), 1) = 1
      const result = checkRateLimit(limits, CRITICAL_WINDOW, NOW);
      expect(result.allowed).toBe(true);
      expect(result.effectiveLimit).toBe(1);
    });

    it("rejects only after minimum 1 request at critical", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 5,
        currentPeriodRequests: 1,
      });
      // Critical: effective = 1, but already used 1
      const result = checkRateLimit(limits, CRITICAL_WINDOW, NOW);
      expect(result.allowed).toBe(false);
      expect(result.effectiveLimit).toBe(1);
    });
  });

  describe("empty window (no batch history)", () => {
    it("uses healthy factor (1.0) when no batch data exists", () => {
      const limits = makeUserLimits({
        maxRequestsPerHour: 100,
        currentPeriodRequests: 50,
      });
      const result = checkRateLimit(limits, EMPTY_WINDOW, NOW);
      expect(result.allowed).toBe(true);
      expect(result.health?.reason).toBe("healthy");
      expect(result.effectiveLimit).toBe(100);
    });
  });
});

// ---------------------------------------------------------------------------
// buildRateLimitHeaders
// ---------------------------------------------------------------------------

describe("buildRateLimitHeaders", () => {
  it("includes all three headers when rate limited", () => {
    const headers = buildRateLimitHeaders({
      allowed: false,
      reason: "request_limit_exceeded",
      retryAfterSeconds: 600,
      health: { factor: 0.5, reason: "partial_failures" },
      effectiveLimit: 50,
    });
    expect(headers["Retry-After"]).toBe("600");
    expect(headers["X-Norush-Health"]).toBe("partial_failures");
    expect(headers["X-Norush-Effective-Limit"]).toBe("50");
  });

  it("omits Retry-After when not present", () => {
    const headers = buildRateLimitHeaders({
      allowed: true,
      health: { factor: 1.0, reason: "healthy" },
      effectiveLimit: 100,
    });
    expect(headers["Retry-After"]).toBeUndefined();
    expect(headers["X-Norush-Health"]).toBe("healthy");
    expect(headers["X-Norush-Effective-Limit"]).toBe("100");
  });

  it("handles minimal result", () => {
    const headers = buildRateLimitHeaders({ allowed: true });
    expect(Object.keys(headers)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// nextPeriodReset
// ---------------------------------------------------------------------------

describe("nextPeriodReset", () => {
  it("returns a date 1 hour from now", () => {
    const reset = nextPeriodReset(NOW);
    expect(reset.getTime()).toBe(NOW.getTime() + DEFAULT_PERIOD_MS);
  });
});
