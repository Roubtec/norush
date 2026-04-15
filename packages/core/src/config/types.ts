/**
 * Three-tier configuration types.
 *
 * Tier 1: Environment — set by infrastructure (env vars, immutable at runtime).
 * Tier 2: Operator   — set by whoever deploys norush (file or env).
 * Tier 3: User       — set by end users via UI or API (database).
 *
 * Resolution: environment settings are immutable and cannot be overridden by
 * operator or user config. For resolved values, defaults cascade user →
 * operator → library default, with user settings clamped to operator caps.
 */

import type { ProviderName } from '../types.js';

// ---------------------------------------------------------------------------
// Batching config
// ---------------------------------------------------------------------------

export interface BatchingConfig {
  /** Flush the queue when it reaches this many requests. */
  maxRequests: number;
  /** Flush the queue when serialized size reaches this many bytes. */
  maxBytes: number;
  /** Auto-flush interval in milliseconds. */
  flushIntervalMs: number;
}

// ---------------------------------------------------------------------------
// Polling config
// ---------------------------------------------------------------------------

export interface PollingConfig {
  /** Base polling interval in milliseconds. */
  intervalMs: number;
  /** Maximum number of retries for expired/failed batches. */
  maxRetries: number;
}

// ---------------------------------------------------------------------------
// Provider key config
// ---------------------------------------------------------------------------

export interface ProviderKeyConfig {
  apiKey: string;
  label?: string;
  failoverEnabled?: boolean;
  priority?: number;
}

// ---------------------------------------------------------------------------
// Tier 1: Environment config (immutable at runtime)
// ---------------------------------------------------------------------------

export interface EnvConfig {
  /** Master encryption key for API key vault. */
  masterKey?: string;
  /** PostgreSQL connection string. */
  databaseUrl?: string;
  /** Node environment. */
  nodeEnv?: string;
}

// ---------------------------------------------------------------------------
// Tier 2: Operator config (deployment-time settings and caps)
// ---------------------------------------------------------------------------

export interface OperatorConfig {
  /** Maximum retention days that any user can request. */
  maxRetentionDays?: number;
  /** Default retention days when user has no preference. */
  defaultRetentionDays?: number;

  /** Batching configuration caps and defaults. */
  batching?: Partial<BatchingConfig>;

  /** Polling configuration caps and defaults. */
  polling?: Partial<PollingConfig>;

  /** Circuit breaker: consecutive failures before tripping. */
  circuitBreakerThreshold?: number;
  /** Circuit breaker: cooldown in milliseconds after trip. */
  circuitBreakerCooldownMs?: number;

  /** Global rate limit: maximum requests per hour across all users. */
  globalMaxRequestsPerHour?: number;

  /** Provider keys configured at the operator level. */
  providers?: Partial<Record<ProviderName, ProviderKeyConfig[]>>;
}

// ---------------------------------------------------------------------------
// Tier 3: User config (per-user preferences, stored in database)
// ---------------------------------------------------------------------------

export interface UserConfig {
  /** User's preferred retention in days. Clamped to operator cap. */
  retentionDays?: number;

  /** Per-user batching preferences (clamped to operator caps). */
  batching?: Partial<BatchingConfig>;

  /** Per-user polling preferences (clamped to operator caps). */
  polling?: Partial<PollingConfig>;
}

// ---------------------------------------------------------------------------
// Resolved config (output of resolveConfig)
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  /** Resolved retention policy in days. */
  retentionDays: number;

  /** Resolved batching configuration. */
  batching: BatchingConfig;

  /** Resolved polling configuration. */
  polling: PollingConfig;

  /** Circuit breaker threshold. */
  circuitBreakerThreshold: number;

  /** Circuit breaker cooldown in milliseconds. */
  circuitBreakerCooldownMs: number;
}
