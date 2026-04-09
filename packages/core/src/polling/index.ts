/**
 * Polling strategy factory, registry, and public API.
 *
 * Resolves a preset name to a PollingStrategy implementation and applies
 * interval clamping as a wrapper around any strategy.
 */

import type { PollingStrategy } from "../interfaces/polling.js";
import type { PollContext } from "../types.js";
import { clampInterval } from "./clamp.js";
import {
  BackoffStrategy,
  DeadlineAwareStrategy,
  EagerStrategy,
  LinearStrategy,
  type PollingPreset,
} from "./strategies.js";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { clampInterval, MAX_INTERVAL_MS, MIN_INTERVAL_MS } from "./clamp.js";
export {
  BackoffStrategy,
  DeadlineAwareStrategy,
  EagerStrategy,
  LinearStrategy,
  type PollingPreset,
} from "./strategies.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const presets: Record<PollingPreset, () => PollingStrategy> = Object.assign(
  Object.create(null) as Record<PollingPreset, () => PollingStrategy>,
  {
    linear: () => new LinearStrategy(),
    backoff: () => new BackoffStrategy(),
    "deadline-aware": () => new DeadlineAwareStrategy(),
    eager: () => new EagerStrategy(),
  },
);

/**
 * Returns true if `name` is a known preset strategy name.
 */
export function isPollingPreset(name: string): name is PollingPreset {
  return Object.prototype.hasOwnProperty.call(presets, name);
}

/**
 * Resolve a preset name to a new PollingStrategy instance.
 *
 * @throws {Error} if the name is not a known preset.
 */
export function getStrategy(name: string): PollingStrategy {
  if (!isPollingPreset(name)) {
    throw new Error(
      `Unknown polling strategy "${name}". ` +
        `Available presets: ${Object.keys(presets).join(", ")}`,
    );
  }
  return presets[name]();
}

// ---------------------------------------------------------------------------
// Clamped wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap any PollingStrategy so its returned intervals are clamped to the
 * safe range [MIN_INTERVAL_MS, MAX_INTERVAL_MS].
 */
export function withClamping(strategy: PollingStrategy): PollingStrategy {
  return {
    nextInterval(context: PollContext): number {
      return clampInterval(strategy.nextInterval(context));
    },
  };
}

/**
 * Convenience: resolve a preset name and return it with clamping applied.
 */
export function getClampedStrategy(name: string): PollingStrategy {
  return withClamping(getStrategy(name));
}
