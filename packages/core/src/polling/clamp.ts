/**
 * Interval clamping utility for polling strategies.
 *
 * Enforces a safe range on any polling interval returned by a strategy.
 * Applied as a post-processing step so strategies stay pure and clamping
 * is independently testable.
 */

/** Minimum polling interval: 10 seconds (protects against rate limits). */
export const MIN_INTERVAL_MS = 10_000;

/** Maximum polling interval: 15 minutes (ensures we don't miss expiry windows). */
export const MAX_INTERVAL_MS = 900_000;

/**
 * Clamp an interval to the safe range [MIN_INTERVAL_MS, MAX_INTERVAL_MS].
 */
export function clampInterval(intervalMs: number): number {
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, intervalMs));
}
