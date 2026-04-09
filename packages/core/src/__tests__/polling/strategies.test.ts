import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PollContext } from "../../types.js";
import { clampInterval, MAX_INTERVAL_MS, MIN_INTERVAL_MS } from "../../polling/clamp.js";
import {
  BackoffStrategy,
  DeadlineAwareStrategy,
  EagerStrategy,
  LinearStrategy,
} from "../../polling/strategies.js";
import {
  getClampedStrategy,
  getStrategy,
  isPollingPreset,
  withClamping,
} from "../../polling/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a PollContext with sensible defaults; override as needed. */
function makePollContext(overrides: Partial<PollContext> = {}): PollContext {
  const now = Date.now();
  return {
    batchId: "test-batch-001",
    provider: "claude",
    submittedAt: new Date(now - 60_000), // 1 minute ago
    lastPolledAt: null,
    pollCount: 0,
    expiresAt: new Date(now + 24 * 60 * 60_000), // 24h from now
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

describe("clampInterval", () => {
  it("returns the value unchanged when within range", () => {
    expect(clampInterval(60_000)).toBe(60_000);
  });

  it("clamps below minimum to MIN_INTERVAL_MS (10s)", () => {
    expect(clampInterval(0)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(5_000)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(-1)).toBe(MIN_INTERVAL_MS);
  });

  it("clamps above maximum to MAX_INTERVAL_MS (15min)", () => {
    expect(clampInterval(1_000_000)).toBe(MAX_INTERVAL_MS);
    expect(clampInterval(999_999_999)).toBe(MAX_INTERVAL_MS);
  });

  it("returns exact boundary values", () => {
    expect(clampInterval(MIN_INTERVAL_MS)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(MAX_INTERVAL_MS)).toBe(MAX_INTERVAL_MS);
  });

  it("has MIN_INTERVAL_MS = 10_000 and MAX_INTERVAL_MS = 900_000", () => {
    expect(MIN_INTERVAL_MS).toBe(10_000);
    expect(MAX_INTERVAL_MS).toBe(900_000);
  });
});

// ---------------------------------------------------------------------------
// LinearStrategy
// ---------------------------------------------------------------------------

describe("LinearStrategy", () => {
  it("returns the default interval (60s) when constructed without args", () => {
    const strategy = new LinearStrategy();
    const ctx = makePollContext();
    expect(strategy.nextInterval(ctx)).toBe(60_000);
  });

  it("returns the configured interval", () => {
    const strategy = new LinearStrategy(45_000);
    const ctx = makePollContext();
    expect(strategy.nextInterval(ctx)).toBe(45_000);
  });

  it("returns the same interval regardless of poll count", () => {
    const strategy = new LinearStrategy(30_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 0 }))).toBe(30_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 5 }))).toBe(30_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 100 }))).toBe(30_000);
  });

  it("is a pure function of context — no internal state mutation", () => {
    const strategy = new LinearStrategy();
    const ctx = makePollContext();
    const first = strategy.nextInterval(ctx);
    const second = strategy.nextInterval(ctx);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// BackoffStrategy
// ---------------------------------------------------------------------------

describe("BackoffStrategy", () => {
  it("starts at 30s on first poll", () => {
    const strategy = new BackoffStrategy();
    const ctx = makePollContext({ pollCount: 0 });
    // 30_000 * 2^0 = 30_000
    expect(strategy.nextInterval(ctx)).toBe(30_000);
  });

  it("doubles each subsequent poll", () => {
    const strategy = new BackoffStrategy();
    expect(strategy.nextInterval(makePollContext({ pollCount: 0 }))).toBe(30_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 1 }))).toBe(60_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 2 }))).toBe(120_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 3 }))).toBe(240_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 4 }))).toBe(480_000);
  });

  it("caps at 600_000 (10 minutes)", () => {
    const strategy = new BackoffStrategy();
    // 30_000 * 2^5 = 960_000 > 600_000
    expect(strategy.nextInterval(makePollContext({ pollCount: 5 }))).toBe(600_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 10 }))).toBe(600_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 100 }))).toBe(600_000);
  });

  it("accepts custom base and cap", () => {
    const strategy = new BackoffStrategy(10_000, 100_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 0 }))).toBe(10_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 1 }))).toBe(20_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 2 }))).toBe(40_000);
    expect(strategy.nextInterval(makePollContext({ pollCount: 3 }))).toBe(80_000);
    // 10_000 * 2^4 = 160_000 > 100_000
    expect(strategy.nextInterval(makePollContext({ pollCount: 4 }))).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// DeadlineAwareStrategy
// ---------------------------------------------------------------------------

describe("DeadlineAwareStrategy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns near-max interval when mostly time remaining", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const strategy = new DeadlineAwareStrategy();
    const ctx = makePollContext({
      submittedAt: new Date(now),
      expiresAt: new Date(now + 24 * 60 * 60_000), // 24h window
    });

    const interval = strategy.nextInterval(ctx);
    // At time=0, fractionRemaining~=1.0, so interval should be near maxIntervalMs (300_000)
    expect(interval).toBeGreaterThan(290_000);
    expect(interval).toBeLessThanOrEqual(300_000);
  });

  it("returns near-min interval when close to deadline", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const strategy = new DeadlineAwareStrategy();
    const ctx = makePollContext({
      submittedAt: new Date(now - 24 * 60 * 60_000), // submitted 24h ago
      expiresAt: new Date(now + 60_000), // expires in 1 minute
    });

    const interval = strategy.nextInterval(ctx);
    // remaining / total is very small, so interval should be near minIntervalMs (15_000)
    expect(interval).toBeLessThan(20_000);
    expect(interval).toBeGreaterThanOrEqual(15_000);
  });

  it("accelerates as deadline approaches", () => {
    const strategy = new DeadlineAwareStrategy();
    const submittedAt = new Date(0);
    const expiresAt = new Date(100_000); // 100s window

    // At 25% through the window (25s elapsed)
    vi.setSystemTime(25_000);
    const interval25 = strategy.nextInterval(
      makePollContext({ submittedAt, expiresAt }),
    );

    // At 75% through the window (75s elapsed)
    vi.setSystemTime(75_000);
    const interval75 = strategy.nextInterval(
      makePollContext({ submittedAt, expiresAt }),
    );

    // Later in the window should have a shorter interval
    expect(interval75).toBeLessThan(interval25);
  });

  it("returns min interval when already past deadline", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const strategy = new DeadlineAwareStrategy();
    const ctx = makePollContext({
      submittedAt: new Date(now - 2 * 60 * 60_000),
      expiresAt: new Date(now - 60_000), // already expired
    });

    const interval = strategy.nextInterval(ctx);
    expect(interval).toBe(15_000);
  });

  it("returns min interval when expiresAt equals submittedAt (zero window)", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const strategy = new DeadlineAwareStrategy();
    const ctx = makePollContext({
      submittedAt: new Date(now),
      expiresAt: new Date(now),
    });

    expect(strategy.nextInterval(ctx)).toBe(15_000);
  });

  it("returns exactly halfway between min and max at 50% remaining", () => {
    const strategy = new DeadlineAwareStrategy(10_000, 310_000);
    const submittedAt = new Date(0);
    const expiresAt = new Date(100_000);

    // At exactly 50% through -> 50% remaining
    vi.setSystemTime(50_000);
    const interval = strategy.nextInterval(
      makePollContext({ submittedAt, expiresAt }),
    );

    // 10_000 + 0.5 * (310_000 - 10_000) = 10_000 + 150_000 = 160_000
    expect(interval).toBe(160_000);
  });
});

// ---------------------------------------------------------------------------
// EagerStrategy
// ---------------------------------------------------------------------------

describe("EagerStrategy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 15s during the first 5 minutes", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const strategy = new EagerStrategy();
    const ctx = makePollContext({
      submittedAt: new Date(now), // just submitted
      pollCount: 0,
    });

    expect(strategy.nextInterval(ctx)).toBe(15_000);
  });

  it("returns 15s at 4 minutes 59 seconds", () => {
    const now = Date.now();
    const submittedAt = new Date(now);

    // Advance to just under 5 minutes
    vi.setSystemTime(now + 299_999);

    const strategy = new EagerStrategy();
    const ctx = makePollContext({ submittedAt, pollCount: 10 });

    expect(strategy.nextInterval(ctx)).toBe(15_000);
  });

  it("falls back to backoff after 5 minutes", () => {
    const now = Date.now();
    const submittedAt = new Date(now);

    // Advance to exactly 5 minutes
    vi.setSystemTime(now + 300_000);

    const strategy = new EagerStrategy();
    const ctx = makePollContext({ submittedAt, pollCount: 0 });

    // After 5 min, should use backoff: 30_000 * 2^0 = 30_000
    expect(strategy.nextInterval(ctx)).toBe(30_000);
  });

  it("uses backoff doubling after eager window ends", () => {
    const now = Date.now();
    const submittedAt = new Date(now);

    vi.setSystemTime(now + 600_000); // 10 minutes in

    const strategy = new EagerStrategy();

    // pollCount=3: 30_000 * 2^3 = 240_000
    expect(
      strategy.nextInterval(makePollContext({ submittedAt, pollCount: 3 })),
    ).toBe(240_000);
  });

  it("caps backoff at 600_000 after eager window", () => {
    const now = Date.now();
    const submittedAt = new Date(now);

    vi.setSystemTime(now + 600_000);

    const strategy = new EagerStrategy();

    expect(
      strategy.nextInterval(makePollContext({ submittedAt, pollCount: 10 })),
    ).toBe(600_000);
  });
});

// ---------------------------------------------------------------------------
// Registry / Factory
// ---------------------------------------------------------------------------

describe("getStrategy", () => {
  it("resolves 'linear' to a LinearStrategy", () => {
    const strategy = getStrategy("linear");
    expect(strategy).toBeInstanceOf(LinearStrategy);
  });

  it("resolves 'backoff' to a BackoffStrategy", () => {
    const strategy = getStrategy("backoff");
    expect(strategy).toBeInstanceOf(BackoffStrategy);
  });

  it("resolves 'deadline-aware' to a DeadlineAwareStrategy", () => {
    const strategy = getStrategy("deadline-aware");
    expect(strategy).toBeInstanceOf(DeadlineAwareStrategy);
  });

  it("resolves 'eager' to a EagerStrategy", () => {
    const strategy = getStrategy("eager");
    expect(strategy).toBeInstanceOf(EagerStrategy);
  });

  it("throws for unknown preset names", () => {
    expect(() => getStrategy("unknown")).toThrow(
      'Unknown polling strategy "unknown"',
    );
  });

  it("returns a new instance on each call", () => {
    const a = getStrategy("linear");
    const b = getStrategy("linear");
    expect(a).not.toBe(b);
  });
});

describe("isPollingPreset", () => {
  it("returns true for known presets", () => {
    expect(isPollingPreset("linear")).toBe(true);
    expect(isPollingPreset("backoff")).toBe(true);
    expect(isPollingPreset("deadline-aware")).toBe(true);
    expect(isPollingPreset("eager")).toBe(true);
  });

  it("returns false for unknown names", () => {
    expect(isPollingPreset("unknown")).toBe(false);
    expect(isPollingPreset("")).toBe(false);
    expect(isPollingPreset("LINEAR")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withClamping wrapper
// ---------------------------------------------------------------------------

describe("withClamping", () => {
  it("clamps a strategy that returns below minimum", () => {
    const tooFast = { nextInterval: () => 1_000 };
    const clamped = withClamping(tooFast);
    expect(clamped.nextInterval(makePollContext())).toBe(MIN_INTERVAL_MS);
  });

  it("clamps a strategy that returns above maximum", () => {
    const tooSlow = { nextInterval: () => 2_000_000 };
    const clamped = withClamping(tooSlow);
    expect(clamped.nextInterval(makePollContext())).toBe(MAX_INTERVAL_MS);
  });

  it("passes through values within range", () => {
    const normal = { nextInterval: () => 60_000 };
    const clamped = withClamping(normal);
    expect(clamped.nextInterval(makePollContext())).toBe(60_000);
  });

  it("delegates to the wrapped strategy with the correct context", () => {
    const spy = { nextInterval: vi.fn().mockReturnValue(30_000) };
    const clamped = withClamping(spy);
    const ctx = makePollContext({ pollCount: 7 });

    clamped.nextInterval(ctx);

    expect(spy.nextInterval).toHaveBeenCalledWith(ctx);
    expect(spy.nextInterval).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getClampedStrategy
// ---------------------------------------------------------------------------

describe("getClampedStrategy", () => {
  it("returns a clamped strategy for a valid preset", () => {
    const strategy = getClampedStrategy("linear");
    const ctx = makePollContext();
    // Linear defaults to 60_000 which is within clamp range
    expect(strategy.nextInterval(ctx)).toBe(60_000);
  });

  it("throws for unknown preset names", () => {
    expect(() => getClampedStrategy("nope")).toThrow(
      'Unknown polling strategy "nope"',
    );
  });

  it("clamps backoff at high poll counts to MAX_INTERVAL_MS", () => {
    const strategy = getClampedStrategy("backoff");
    // At pollCount=100, raw backoff would be astronomically large, capped first
    // at 600_000 by the strategy itself, which is within clamp range.
    const ctx = makePollContext({ pollCount: 100 });
    expect(strategy.nextInterval(ctx)).toBe(600_000);
  });
});
