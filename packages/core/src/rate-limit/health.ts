/**
 * Health score computation for adaptive rate limiting.
 *
 * Computes a health factor from a sliding window of batch outcomes.
 * The factor is multiplied against the user's base rate limit to produce
 * an effective limit that automatically tightens during failure cascades
 * and recovers as successes enter the window.
 *
 * See PLAN.md Section 6.4 (Adaptive Rate Limiting with Health Scores).
 */

import type { HealthScore, SlidingWindow } from '../types.js';

/**
 * Compute a health score from a sliding window of batch outcomes.
 *
 * Exactly matches PLAN.md:
 *   successRate >= 0.9  -> factor 1.0  (healthy)
 *   successRate >= 0.5  -> factor 0.5  (partial_failures)
 *   successRate > 0     -> factor 0.25 (mostly_failing)
 *   successRate = 0     -> factor 0.1  (critical)
 *
 * When the window has no data (total === 0), the user gets full rate.
 */
export function computeHealth(window: SlidingWindow): HealthScore {
  const { succeeded, total } = window;

  if (total === 0) return { factor: 1.0, reason: 'healthy' };

  const successRate = succeeded / total;

  if (successRate >= 0.9) return { factor: 1.0, reason: 'healthy' };
  if (successRate >= 0.5) return { factor: 0.5, reason: 'partial_failures' };
  if (successRate > 0) return { factor: 0.25, reason: 'mostly_failing' };
  return { factor: 0.1, reason: 'critical' };
}

/**
 * Compute the effective rate limit given a base limit and a health score.
 *
 * Guarantees a minimum throughput of 1 request per period even at critical
 * health, so users always have an avenue to prove recovery.
 */
export function computeEffectiveLimit(baseLimit: number, health: HealthScore): number {
  const raw = Math.floor(baseLimit * health.factor);
  // Minimum throughput guarantee: at least 1 per period.
  return Math.max(raw, 1);
}
