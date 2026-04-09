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
// Telemetry implementations
// ---------------------------------------------------------------------------

export { NoopTelemetry } from "./telemetry/noop.js";
export { ConsoleTelemetry } from "./telemetry/console.js";
