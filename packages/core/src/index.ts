/**
 * @norush/core — Deferred LLM batch execution engine.
 *
 * Public API: all types, interfaces, config resolution, and telemetry
 * implementations are re-exported from this single entry point.
 */

export const VERSION = "0.0.0";

// ---------------------------------------------------------------------------
// Data types and status unions
// ---------------------------------------------------------------------------

export type {
  NorushId,
  BatchId,
  ResultId,
  ProviderName,
  RequestStatus,
  BatchStatus,
  DeliveryStatus,
  ProviderBatchRef,
  NewRequest,
  Request,
  NorushRequest,
  NewBatch,
  Batch,
  NewResult,
  Result,
  NorushResult,
  PollContext,
  DateRange,
  UsageStats,
  HealthScore,
} from "./types.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export type { Provider } from "./interfaces/provider.js";
export type { Store } from "./interfaces/store.js";
export type { PollingStrategy } from "./interfaces/polling.js";
export type { TelemetryHook } from "./interfaces/telemetry.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type {
  BatchingConfig,
  PollingConfig,
  ProviderKeyConfig,
  EnvConfig,
  OperatorConfig,
  UserConfig,
  ResolvedConfig,
} from "./config/types.js";

export { resolveConfig } from "./config/resolve.js";

// ---------------------------------------------------------------------------
// Store implementations
// ---------------------------------------------------------------------------

export { MemoryStore } from "./store/memory.js";
export { PostgresStore } from "./store/postgres.js";
export { migrate } from "./store/migrate.js";

// ---------------------------------------------------------------------------
// Polling strategies
// ---------------------------------------------------------------------------

export {
  LinearStrategy,
  BackoffStrategy,
  DeadlineAwareStrategy,
  EagerStrategy,
  type PollingPreset,
} from "./polling/strategies.js";

export {
  clampInterval,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  isPollingPreset,
  getStrategy,
  withClamping,
  getClampedStrategy,
} from "./polling/index.js";

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

export {
  ClaudeAdapter,
  type ClaudeAdapterOptions,
} from "./providers/claude.js";

export {
  OpenAIBatchAdapter,
  type OpenAIBatchAdapterOptions,
} from "./providers/openai-batch.js";

// ---------------------------------------------------------------------------
// Engine (queue + batch manager)
// ---------------------------------------------------------------------------

export {
  RequestQueue,
  estimateBytes,
  type RequestQueueOptions,
  BatchManager,
  PROVIDER_LIMITS,
  type BatchManagerOptions,
  type ProviderLimits,
  StatusTracker,
  type StatusTrackerOptions,
  type StatusTrackerEventName,
  type StatusTrackerEventHandler,
  OrphanRecovery,
  type OrphanRecoveryOptions,
  type OrphanRecoveryResult,
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
  type CircuitBreakerSnapshot,
} from "./engine/index.js";

// ---------------------------------------------------------------------------
// Telemetry implementations
// ---------------------------------------------------------------------------

export { NoopTelemetry } from "./telemetry/noop.js";
export { ConsoleTelemetry } from "./telemetry/console.js";
