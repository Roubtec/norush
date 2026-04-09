/**
 * Three-tier config resolution.
 *
 * Merges environment (Tier 1), operator (Tier 2), and user (Tier 3) config
 * with correct precedence and clamping:
 *
 * - Environment settings are immutable and always win.
 * - Operator settings override library defaults.
 * - User settings override operator defaults but are clamped to operator caps.
 *
 * For numeric "cap" fields (retention, maxRequests, etc.), user values are
 * clamped using Math.min so they cannot exceed the operator's maximum.
 */

import type {
  BatchingConfig,
  EnvConfig,
  OperatorConfig,
  PollingConfig,
  ResolvedConfig,
  UserConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Library defaults (baseline when neither operator nor user specifies)
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION_DAYS = 7;

const DEFAULT_BATCHING: BatchingConfig = {
  maxRequests: 1000,
  maxBytes: 50_000_000,
  flushIntervalMs: 300_000,
};

const DEFAULT_POLLING: PollingConfig = {
  intervalMs: 60_000,
  maxRetries: 3,
};

const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 600_000; // 10 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a value to be at most `cap`. If either value is undefined, fall back
 * to `fallback`. Guarantees the result never exceeds `cap` when cap is defined.
 */
function clampMax(
  userValue: number | undefined,
  operatorCap: number | undefined,
  fallback: number,
): number {
  const value = userValue ?? operatorCap ?? fallback;
  if (operatorCap !== undefined) {
    return Math.min(value, operatorCap);
  }
  return value;
}

/**
 * Clamp a value to be at least `floor`. If either value is undefined, fall
 * back to `fallback`. Guarantees the result is never below `floor` when floor
 * is defined.
 */
function clampMin(
  userValue: number | undefined,
  operatorFloor: number | undefined,
  fallback: number,
): number {
  const value = userValue ?? operatorFloor ?? fallback;
  if (operatorFloor !== undefined) {
    return Math.max(value, operatorFloor);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the final configuration by merging three tiers.
 *
 * @param _env      - Tier 1: environment config (reserved for future use in resolution)
 * @param operator  - Tier 2: operator deployment config
 * @param user      - Tier 3: per-user preferences
 * @returns Fully resolved, clamped configuration.
 */
export function resolveConfig(
  _env: EnvConfig = {},
  operator: OperatorConfig = {},
  user: UserConfig = {},
): ResolvedConfig {
  // -- Retention ------------------------------------------------------------
  // User preference is clamped to operator's maximum.
  // Falls back to operator default, then library default.
  const operatorMaxRetention = operator.maxRetentionDays;
  const operatorDefaultRetention =
    operator.defaultRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const userRetention = user.retentionDays ?? operatorDefaultRetention;
  const retentionDays =
    operatorMaxRetention !== undefined
      ? Math.min(userRetention, operatorMaxRetention)
      : userRetention;

  // -- Batching -------------------------------------------------------------
  // User values are clamped to operator caps (which act as maximums).
  const batching: BatchingConfig = {
    maxRequests: clampMax(
      user.batching?.maxRequests,
      operator.batching?.maxRequests,
      DEFAULT_BATCHING.maxRequests,
    ),
    maxBytes: clampMax(
      user.batching?.maxBytes,
      operator.batching?.maxBytes,
      DEFAULT_BATCHING.maxBytes,
    ),
    flushIntervalMs: clampMin(
      user.batching?.flushIntervalMs,
      operator.batching?.flushIntervalMs,
      DEFAULT_BATCHING.flushIntervalMs,
    ),
  };

  // -- Polling --------------------------------------------------------------
  // intervalMs: user cannot go below operator floor (poll too aggressively).
  // maxRetries: user cannot exceed operator cap.
  const polling: PollingConfig = {
    intervalMs: clampMin(
      user.polling?.intervalMs,
      operator.polling?.intervalMs,
      DEFAULT_POLLING.intervalMs,
    ),
    maxRetries: clampMax(
      user.polling?.maxRetries,
      operator.polling?.maxRetries,
      DEFAULT_POLLING.maxRetries,
    ),
  };

  // -- Circuit breaker (operator-only, not user-configurable) ---------------
  const circuitBreakerThreshold =
    operator.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
  const circuitBreakerCooldownMs =
    operator.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;

  return {
    retentionDays,
    batching,
    polling,
    circuitBreakerThreshold,
    circuitBreakerCooldownMs,
  };
}
