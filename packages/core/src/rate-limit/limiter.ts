/**
 * Rate limiter — enforces per-user spend limits at enqueue time.
 *
 * Checks the user's configured limits against their current period counters.
 * Integrates with the adaptive health score to produce an effective limit
 * that tightens during failure cascades.
 *
 * Design decisions:
 * - Check happens at enqueue, before the request is persisted. This prevents
 *   runaway scripts from filling the queue.
 * - Already-submitted batches are never cancelled (PLAN.md spec).
 * - Period counters auto-reset when period_reset_at passes.
 * - The hard_spend_limit_usd is cumulative and never resets per-period.
 */

import type {
  RateLimitResult,
  SlidingWindow,
  UserLimits,
} from "../types.js";
import { computeHealth, computeEffectiveLimit } from "./health.js";

/**
 * Default sliding window duration in milliseconds (1 hour).
 */
export const DEFAULT_WINDOW_MS = 3_600_000;

/**
 * Default hourly period duration in milliseconds (1 hour).
 */
export const DEFAULT_PERIOD_MS = 3_600_000;

/**
 * Check whether a user is allowed to enqueue a new request.
 *
 * @param limits - The user's current limits and counters. If null, the user
 *                 has no limits configured and all requests are allowed.
 * @param window - The sliding window of batch outcomes for health computation.
 * @param now    - Current time (injectable for testing).
 *
 * @returns A RateLimitResult indicating whether the request is allowed.
 */
export function checkRateLimit(
  limits: UserLimits | null,
  window: SlidingWindow,
  now: Date = new Date(),
): RateLimitResult {
  // No limits configured — allow everything.
  if (!limits) {
    const health = computeHealth(window);
    return { allowed: true, health };
  }

  const health = computeHealth(window);

  // Check hard spend limit first — this is cumulative and never resets.
  if (
    limits.hardSpendLimitUsd !== null &&
    limits.currentSpendUsd >= limits.hardSpendLimitUsd
  ) {
    return {
      allowed: false,
      reason: "hard_spend_limit_exceeded",
      health,
      effectiveLimit: 0,
    };
  }

  // Determine if the period has reset. If so, counters are effectively 0.
  const periodExpired = now >= limits.periodResetAt;
  const currentRequests = periodExpired ? 0 : limits.currentPeriodRequests;
  const currentTokens = periodExpired ? 0 : limits.currentPeriodTokens;

  // Check request limit with health factor applied.
  if (limits.maxRequestsPerHour !== null) {
    const effectiveLimit = computeEffectiveLimit(
      limits.maxRequestsPerHour,
      health,
    );

    if (currentRequests >= effectiveLimit) {
      const retryAfterSeconds = periodExpired
        ? 0
        : Math.ceil(
            (limits.periodResetAt.getTime() - now.getTime()) / 1000,
          );

      return {
        allowed: false,
        reason: "request_limit_exceeded",
        retryAfterSeconds: Math.max(retryAfterSeconds, 1),
        health,
        effectiveLimit,
      };
    }
  }

  // Check token limit (not health-adjusted — tokens are consumption-based).
  if (limits.maxTokensPerDay !== null && currentTokens >= limits.maxTokensPerDay) {
    const retryAfterSeconds = periodExpired
      ? 0
      : Math.ceil(
          (limits.periodResetAt.getTime() - now.getTime()) / 1000,
        );

    return {
      allowed: false,
      reason: "token_limit_exceeded",
      retryAfterSeconds: Math.max(retryAfterSeconds, 1),
      health,
      effectiveLimit: limits.maxTokensPerDay,
    };
  }

  // Compute effective limit for the response header, even when allowed.
  const effectiveLimit = limits.maxRequestsPerHour !== null
    ? computeEffectiveLimit(limits.maxRequestsPerHour, health)
    : undefined;

  return { allowed: true, health, effectiveLimit };
}

/**
 * Build 429 response headers from a rate limit result.
 *
 * Returns an object suitable for setting on an HTTP response:
 *   Retry-After, X-Norush-Health, X-Norush-Effective-Limit
 */
export function buildRateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (result.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }

  if (result.health) {
    headers["X-Norush-Health"] = result.health.reason;
  }

  if (result.effectiveLimit !== undefined) {
    headers["X-Norush-Effective-Limit"] = String(result.effectiveLimit);
  }

  return headers;
}

/**
 * Compute what the next period reset time should be.
 * Used when creating new limits or resetting expired periods.
 */
export function nextPeriodReset(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_PERIOD_MS);
}
