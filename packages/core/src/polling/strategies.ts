/**
 * Built-in polling strategy presets.
 *
 * Each strategy is side-effect-free and has no internal mutable state.
 * Some strategies (DeadlineAwareStrategy, EagerStrategy) also depend on the
 * current time via Date.now() in addition to the PollContext fields.
 * Clamping is applied externally (see clamp.ts), not inside these implementations.
 */

import type { PollingStrategy } from '../interfaces/polling.js';
import type { PollContext } from '../types.js';

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

/**
 * Fixed-interval polling strategy.
 *
 * Returns the same interval every time, regardless of context.
 * Default interval: 60 seconds.
 */
export class LinearStrategy implements PollingStrategy {
  private readonly intervalMs: number;

  constructor(intervalMs: number = 60_000) {
    this.intervalMs = intervalMs;
  }

  nextInterval(_context: PollContext): number {
    return this.intervalMs;
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Exponential backoff polling strategy.
 *
 * Starts at 30s, doubles each poll, capped at 10 minutes.
 * Formula: min(30_000 * 2^pollCount, 600_000)
 */
export class BackoffStrategy implements PollingStrategy {
  private readonly baseMs: number;
  private readonly capMs: number;

  constructor(baseMs: number = 30_000, capMs: number = 600_000) {
    this.baseMs = baseMs;
    this.capMs = capMs;
  }

  nextInterval(context: PollContext): number {
    return Math.min(this.baseMs * Math.pow(2, context.pollCount), this.capMs);
  }
}

// ---------------------------------------------------------------------------
// Deadline-aware
// ---------------------------------------------------------------------------

/**
 * Deadline-aware polling strategy.
 *
 * Polls slowly early on, accelerates as expiresAt approaches.
 * Uses remaining time percentage to interpolate between a slow interval
 * (5 minutes) and a fast interval (15 seconds).
 *
 * When remaining time is 100%, interval is at the slow end (maxIntervalMs).
 * When remaining time is 0%, interval is at the fast end (minIntervalMs).
 * Interpolation is linear between these bounds.
 */
export class DeadlineAwareStrategy implements PollingStrategy {
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;

  constructor(minIntervalMs: number = 15_000, maxIntervalMs: number = 300_000) {
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
  }

  nextInterval(context: PollContext): number {
    const now = Date.now();
    const submittedMs = context.submittedAt.getTime();
    const expiresMs = context.expiresAt.getTime();

    const totalWindow = expiresMs - submittedMs;

    // Guard: if the window is zero or negative (already expired), use min interval
    if (totalWindow <= 0) {
      return this.minIntervalMs;
    }

    const remaining = expiresMs - now;
    const fractionRemaining = Math.max(0, Math.min(1, remaining / totalWindow));

    // Linear interpolation: high remaining -> slow, low remaining -> fast
    return this.minIntervalMs + fractionRemaining * (this.maxIntervalMs - this.minIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Eager
// ---------------------------------------------------------------------------

/**
 * Eager polling strategy.
 *
 * Polls at 15s for the first 5 minutes after submission, then falls back
 * to exponential backoff behavior.
 */
export class EagerStrategy implements PollingStrategy {
  private readonly eagerIntervalMs: number;
  private readonly eagerWindowMs: number;
  private readonly backoff: BackoffStrategy;

  constructor(eagerIntervalMs: number = 15_000, eagerWindowMs: number = 300_000) {
    this.eagerIntervalMs = eagerIntervalMs;
    this.eagerWindowMs = eagerWindowMs;
    this.backoff = new BackoffStrategy();
  }

  nextInterval(context: PollContext): number {
    const elapsed = Date.now() - context.submittedAt.getTime();

    if (elapsed < this.eagerWindowMs) {
      return this.eagerIntervalMs;
    }

    return this.backoff.nextInterval(context);
  }
}

// ---------------------------------------------------------------------------
// Preset name type
// ---------------------------------------------------------------------------

/** Known preset strategy names. */
export type PollingPreset = 'linear' | 'backoff' | 'deadline-aware' | 'eager';
