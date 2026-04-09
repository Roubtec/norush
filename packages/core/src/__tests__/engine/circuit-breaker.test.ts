import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  type CircuitBreakerState,
} from "../../engine/circuit-breaker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBreaker(overrides: {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
} = {}) {
  const telemetry = {
    counter: vi.fn(),
    histogram: vi.fn(),
    event: vi.fn(),
  };

  const cb = new CircuitBreaker({
    threshold: overrides.threshold ?? 3,
    cooldownMs: overrides.cooldownMs ?? 1000,
    telemetry,
    now: overrides.now,
  });

  return { cb, telemetry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe("initial state", () => {
    it("starts in closed state", () => {
      const { cb } = createBreaker();
      expect(cb.state).toBe("closed");
      expect(cb.consecutiveFailures).toBe(0);
    });

    it("allows submissions when closed", () => {
      const { cb } = createBreaker();
      expect(cb.canSubmit()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Tripping (closed -> open)
  // -----------------------------------------------------------------------

  describe("tripping", () => {
    it("stays closed when failures are below threshold", () => {
      const { cb } = createBreaker({ threshold: 3 });

      cb.recordFailure();
      cb.recordFailure();

      expect(cb.state).toBe("closed");
      expect(cb.canSubmit()).toBe(true);
      expect(cb.consecutiveFailures).toBe(2);
    });

    it("trips to open after reaching threshold", () => {
      const { cb, telemetry } = createBreaker({ threshold: 3 });

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.state).toBe("open");
      expect(cb.canSubmit()).toBe(false);
      expect(telemetry.event).toHaveBeenCalledWith(
        "circuit_breaker:tripped",
        expect.objectContaining({ consecutiveFailures: 3 }),
      );
    });

    it("rejects submissions when open", () => {
      const { cb } = createBreaker({ threshold: 1 });

      cb.recordFailure();
      expect(cb.canSubmit()).toBe(false);
    });

    it("uses default threshold of 5 when not specified", () => {
      const cb = new CircuitBreaker();

      for (let i = 0; i < 4; i++) cb.recordFailure();
      expect(cb.state).toBe("closed");

      cb.recordFailure();
      expect(cb.state).toBe("open");
    });
  });

  // -----------------------------------------------------------------------
  // Success resets
  // -----------------------------------------------------------------------

  describe("success resets", () => {
    it("resets consecutive failures on success", () => {
      const { cb } = createBreaker({ threshold: 5 });

      cb.recordFailure();
      cb.recordFailure();
      expect(cb.consecutiveFailures).toBe(2);

      cb.recordSuccess();
      expect(cb.consecutiveFailures).toBe(0);
      expect(cb.state).toBe("closed");
    });

    it("does not trip if success resets the count", () => {
      const { cb } = createBreaker({ threshold: 3 });

      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess(); // reset
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.state).toBe("closed");
      expect(cb.consecutiveFailures).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Cooldown (open -> half_open)
  // -----------------------------------------------------------------------

  describe("cooldown", () => {
    it("transitions to half_open after cooldown elapses", () => {
      let currentTime = 1000;
      const { cb } = createBreaker({
        threshold: 1,
        cooldownMs: 5000,
        now: () => currentTime,
      });

      cb.recordFailure(); // trips at t=1000
      expect(cb.state).toBe("open");

      // Before cooldown
      currentTime = 5999;
      expect(cb.state).toBe("open");
      expect(cb.canSubmit()).toBe(false);

      // After cooldown
      currentTime = 6000;
      expect(cb.state).toBe("half_open");
      expect(cb.canSubmit()).toBe(true);
    });

    it("allows one probe in half_open state", () => {
      let currentTime = 0;
      const { cb } = createBreaker({
        threshold: 1,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure();
      currentTime = 100;

      expect(cb.canSubmit()).toBe(true); // half_open allows probe
    });

    it("rejects subsequent canSubmit() calls in half_open until probe resolves", () => {
      let currentTime = 0;
      const { cb } = createBreaker({
        threshold: 1,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure();
      currentTime = 100;

      expect(cb.canSubmit()).toBe(true);  // first call — probe granted
      expect(cb.canSubmit()).toBe(false); // second call — probe already in flight
    });

    it("resets probe slot after recordSuccess()", () => {
      let currentTime = 0;
      const { cb } = createBreaker({
        threshold: 1,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure();
      currentTime = 100;

      expect(cb.canSubmit()).toBe(true); // probe granted
      cb.recordSuccess();                // probe resolved -> closed
      expect(cb.state).toBe("closed");
      expect(cb.canSubmit()).toBe(true); // back to normal
    });

    it("resets probe slot after recordFailure() (probe re-trips breaker)", () => {
      let currentTime = 0;
      const { cb } = createBreaker({
        threshold: 1,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure();
      currentTime = 100;

      expect(cb.canSubmit()).toBe(true); // probe granted
      expect(cb.canSubmit()).toBe(false); // still in flight
      cb.recordFailure();                // probe failed -> open again

      expect(cb.state).toBe("open");
      expect(cb.canSubmit()).toBe(false);

      // After another full cooldown, a fresh probe is available.
      currentTime = 200;
      expect(cb.canSubmit()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Probe success (half_open -> closed)
  // -----------------------------------------------------------------------

  describe("probe success", () => {
    it("transitions to closed on probe success", () => {
      let currentTime = 0;
      const { cb, telemetry } = createBreaker({
        threshold: 1,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure(); // -> open
      currentTime = 100;   // -> half_open (on next state check)

      cb.recordSuccess(); // probe succeeded -> closed

      expect(cb.state).toBe("closed");
      expect(cb.consecutiveFailures).toBe(0);
      expect(telemetry.event).toHaveBeenCalledWith(
        "circuit_breaker:closed",
        expect.objectContaining({ reason: "probe_succeeded" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Probe failure (half_open -> open)
  // -----------------------------------------------------------------------

  describe("probe failure", () => {
    it("transitions back to open on probe failure", () => {
      let currentTime = 0;
      const { cb, telemetry } = createBreaker({
        threshold: 1,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure(); // -> open at t=0
      currentTime = 100;   // cooldown elapsed

      // Access state to trigger half_open transition.
      expect(cb.state).toBe("half_open");

      cb.recordFailure(); // probe failed -> open again

      expect(cb.state).toBe("open");
      expect(cb.canSubmit()).toBe(false);

      // Should have emitted tripped again.
      const trippedCalls = telemetry.event.mock.calls.filter(
        (c: unknown[]) => c[0] === "circuit_breaker:tripped",
      );
      expect(trippedCalls.length).toBe(2); // once for initial trip, once for probe failure
    });

    it("requires another full cooldown after probe failure", () => {
      let currentTime = 0;
      const { cb } = createBreaker({
        threshold: 1,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure(); // -> open at t=0
      currentTime = 100;   // -> half_open
      expect(cb.state).toBe("half_open");

      cb.recordFailure(); // -> open at t=100
      expect(cb.state).toBe("open");

      // Still in cooldown (only 50ms after re-trip)
      currentTime = 150;
      expect(cb.state).toBe("open");

      // Full cooldown from re-trip
      currentTime = 200;
      expect(cb.state).toBe("half_open");
    });
  });

  // -----------------------------------------------------------------------
  // Manual reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("resets to closed state", () => {
      const { cb, telemetry } = createBreaker({ threshold: 1 });

      cb.recordFailure(); // -> open
      expect(cb.state).toBe("open");

      cb.reset();

      expect(cb.state).toBe("closed");
      expect(cb.consecutiveFailures).toBe(0);
      expect(cb.canSubmit()).toBe(true);
      expect(telemetry.event).toHaveBeenCalledWith("circuit_breaker:reset");
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot
  // -----------------------------------------------------------------------

  describe("snapshot", () => {
    it("returns current state", () => {
      const currentTime = 1000;
      const { cb } = createBreaker({
        threshold: 2,
        cooldownMs: 500,
        now: () => currentTime,
      });

      let snap = cb.snapshot();
      expect(snap).toEqual({
        state: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastTrippedAt: null,
      });

      cb.recordFailure();
      snap = cb.snapshot();
      expect(snap.consecutiveFailures).toBe(1);
      expect(snap.lastFailureAt).toBe(1000);
      expect(snap.state).toBe("closed");

      cb.recordFailure(); // trips
      snap = cb.snapshot();
      expect(snap.state).toBe("open");
      expect(snap.consecutiveFailures).toBe(2);
      expect(snap.lastTrippedAt).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------
  // Full cycle
  // -----------------------------------------------------------------------

  describe("full cycle", () => {
    it("closed -> open -> half_open -> closed", () => {
      let currentTime = 0;
      const { cb } = createBreaker({
        threshold: 2,
        cooldownMs: 500,
        now: () => currentTime,
      });

      const states: CircuitBreakerState[] = [];
      states.push(cb.state); // closed

      cb.recordFailure();
      cb.recordFailure();
      states.push(cb.state); // open

      currentTime = 500;
      states.push(cb.state); // half_open

      cb.recordSuccess();
      states.push(cb.state); // closed

      expect(states).toEqual(["closed", "open", "half_open", "closed"]);
    });

    it("closed -> open -> half_open -> open (probe fails) -> half_open -> closed", () => {
      let currentTime = 0;
      const { cb } = createBreaker({
        threshold: 2,
        cooldownMs: 100,
        now: () => currentTime,
      });

      cb.recordFailure();
      cb.recordFailure(); // -> open
      expect(cb.state).toBe("open");

      currentTime = 100;    // -> half_open
      expect(cb.state).toBe("half_open");

      cb.recordFailure();   // probe fails -> open
      expect(cb.state).toBe("open");

      currentTime = 200;    // -> half_open again
      expect(cb.state).toBe("half_open");

      cb.recordSuccess();   // probe succeeds -> closed
      expect(cb.state).toBe("closed");
    });
  });
});
