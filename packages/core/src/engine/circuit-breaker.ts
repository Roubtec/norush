/**
 * Circuit breaker for batch submissions.
 *
 * State machine: `closed` -> `open` -> `half_open` -> `closed`.
 *
 * - Trips (closed -> open) after N consecutive submission failures.
 * - In `open` state: rejects all new submissions.
 * - After cooldown: transitions to `half_open`, allows one probe batch.
 * - If probe succeeds -> `closed`. If probe fails -> back to `open`.
 */

import type { TelemetryHook } from "../interfaces/telemetry.js";
import { NoopTelemetry } from "../telemetry/noop.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before tripping. Default: 5. */
  threshold?: number;
  /** Cooldown in milliseconds before transitioning to half_open. Default: 600_000 (10 min). */
  cooldownMs?: number;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
  /** Clock function for testability. Returns current time in ms. */
  now?: () => number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastTrippedAt: number | null;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly telemetry: TelemetryHook;
  private readonly now: () => number;

  private _state: CircuitBreakerState = "closed";
  private _consecutiveFailures = 0;
  private _lastFailureAt: number | null = null;
  private _lastTrippedAt: number | null = null;
  /** True when a probe submission has been granted in half_open state. */
  private _probeInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 600_000;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
    this.now = options.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Current state of the circuit breaker. */
  get state(): CircuitBreakerState {
    // Check if open state has expired (cooldown elapsed).
    if (this._state === "open" && this._lastTrippedAt !== null) {
      const elapsed = this.now() - this._lastTrippedAt;
      if (elapsed >= this.cooldownMs) {
        this._state = "half_open";
        this._probeInFlight = false;
        this.telemetry.event("circuit_breaker:half_open");
      }
    }
    return this._state;
  }

  /** Number of consecutive failures. */
  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /**
   * Check whether a submission should be allowed.
   *
   * In `closed` state: always allows.
   * In `half_open` state: allows exactly one probe — subsequent calls return
   * `false` until the probe records success or failure.
   * In `open` state (before cooldown): rejects.
   */
  canSubmit(): boolean {
    const currentState = this.state; // triggers cooldown check
    if (currentState === "open") return false;
    if (currentState === "half_open") {
      if (this._probeInFlight) return false;
      this._probeInFlight = true;
      return true;
    }
    return true; // closed
  }

  /**
   * Record a successful submission.
   *
   * Resets the failure counter. If in `half_open`, transitions to `closed`.
   */
  recordSuccess(): void {
    this._consecutiveFailures = 0;
    this._lastFailureAt = null;
    this._probeInFlight = false;

    // Use the getter to trigger cooldown -> half_open transition if needed.
    const currentState = this.state;
    if (currentState === "half_open") {
      this._state = "closed";
      this.telemetry.event("circuit_breaker:closed", {
        reason: "probe_succeeded",
      });
    }
  }

  /**
   * Record a submission failure.
   *
   * Increments the consecutive failure counter. If the threshold is reached
   * (and state is `closed`), trips to `open`. If in `half_open`, goes back
   * to `open`.
   *
   * Returns `true` if this call caused the breaker to transition to `open`
   * (i.e. it just tripped), `false` otherwise.
   */
  recordFailure(): boolean {
    this._consecutiveFailures++;
    this._lastFailureAt = this.now();
    this._probeInFlight = false;

    // Use the getter to trigger cooldown -> half_open transition if needed.
    const currentState = this.state;

    if (currentState === "half_open") {
      // Probe failed — reopen.
      this.trip();
      return true;
    }

    if (
      currentState === "closed" &&
      this._consecutiveFailures >= this.threshold
    ) {
      this.trip();
      return true;
    }

    return false;
  }

  /**
   * Manually reset the circuit breaker to closed state.
   */
  reset(): void {
    this._state = "closed";
    this._consecutiveFailures = 0;
    this._lastFailureAt = null;
    this._lastTrippedAt = null;
    this._probeInFlight = false;
    this.telemetry.event("circuit_breaker:reset");
  }

  /**
   * Return a snapshot of the current state (for observability/API).
   */
  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state, // triggers cooldown check
      consecutiveFailures: this._consecutiveFailures,
      lastFailureAt: this._lastFailureAt,
      lastTrippedAt: this._lastTrippedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private trip(): void {
    this._state = "open";
    this._lastTrippedAt = this.now();
    this.telemetry.event("circuit_breaker:tripped", {
      consecutiveFailures: this._consecutiveFailures,
    });
  }
}
