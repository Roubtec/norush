/**
 * Core data types, status unions, and type aliases for norush.
 *
 * Status values are string literal unions (not enums) for JSON compatibility.
 * ID fields use ULID strings — aliased for clarity but not over-abstracted.
 */

// ---------------------------------------------------------------------------
// ID aliases
// ---------------------------------------------------------------------------

/** ULID string identifying a norush request. */
export type NorushId = string;

/** ULID string identifying a norush batch. */
export type BatchId = string;

/** ULID string identifying a norush result. */
export type ResultId = string;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderName = "claude" | "openai";

// ---------------------------------------------------------------------------
// Status unions
// ---------------------------------------------------------------------------

/** Status of an individual request within the norush lifecycle. */
export type RequestStatus =
  | "queued"
  | "batched"
  | "processing"
  | "succeeded"
  | "failed"
  | "expired"
  | "failed_final"
  | "canceled";

/** Status of a batch submitted to a provider. */
export type BatchStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "ended"
  | "expired"
  | "cancelled"
  | "failed";

/** Delivery status for a result back to the caller. */
export type DeliveryStatus = "pending" | "delivered" | "failed" | "no_target";

// ---------------------------------------------------------------------------
// Provider batch reference
// ---------------------------------------------------------------------------

/** Opaque reference returned by a provider after batch submission. */
export interface ProviderBatchRef {
  /** Provider-assigned batch identifier. */
  providerBatchId: string;
  /** Which provider this batch was submitted to. */
  provider: ProviderName;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Fields required to create a new request (before persistence). */
export interface NewRequest {
  provider: ProviderName;
  model: string;
  params: Record<string, unknown>;
  userId: string;
  callbackUrl?: string | null;
  webhookSecret?: string | null;
  maxRetries?: number;
}

/** Full request record as stored in the database. */
export interface Request {
  id: NorushId;
  externalId: string | null;
  provider: ProviderName;
  model: string;
  params: Record<string, unknown>;
  status: RequestStatus;
  batchId: BatchId | null;
  userId: string;
  callbackUrl: string | null;
  webhookSecret: string | null;
  retryCount: number;
  maxRetries: number;
  contentScrubbedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The payload sent to a provider as part of a batch.
 * Combines the norush request ID with its provider-specific params.
 */
export interface NorushRequest {
  id: NorushId;
  externalId: string;
  provider: ProviderName;
  model: string;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

/** Fields required to create a new batch (before persistence). */
export interface NewBatch {
  provider: ProviderName;
  apiKeyId: string;
  apiKeyLabel?: string | null;
  requestCount: number;
  maxSubmissionAttempts?: number;
  maxProviderRetries?: number;
  pollingStrategy?: string | null;
}

/** Full batch record as stored in the database. */
export interface Batch {
  id: BatchId;
  provider: ProviderName;
  providerBatchId: string | null;
  apiKeyId: string;
  apiKeyLabel: string | null;
  status: BatchStatus;
  requestCount: number;
  succeededCount: number;
  failedCount: number;
  submissionAttempts: number;
  maxSubmissionAttempts: number;
  providerRetries: number;
  maxProviderRetries: number;
  pollingStrategy: string | null;
  submittedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Fields required to create a new result (before persistence). */
export interface NewResult {
  requestId: NorushId;
  batchId: BatchId;
  response: Record<string, unknown>;
  stopReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** Full result record as stored in the database. */
export interface Result {
  id: ResultId;
  requestId: NorushId;
  batchId: BatchId;
  response: Record<string, unknown>;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  deliveryStatus: DeliveryStatus;
  deliveryAttempts: number;
  maxDeliveryAttempts: number;
  lastDeliveryError: string | null;
  nextDeliveryAt: Date | null;
  deliveredAt: Date | null;
  contentScrubbedAt: Date | null;
  createdAt: Date;
}

/**
 * A result as returned by a provider adapter.
 * Maps to the provider's response format before being persisted.
 */
export interface NorushResult {
  /** The norush request ID this result belongs to (mapped from custom_id). */
  requestId: NorushId;
  /** The provider's raw response payload. */
  response: Record<string, unknown>;
  /** Whether this individual request succeeded or failed at the provider. */
  success: boolean;
  /** Stop reason from the provider (e.g., end_turn, max_tokens). */
  stopReason?: string | null;
  /** Number of input tokens consumed. */
  inputTokens?: number | null;
  /** Number of output tokens generated. */
  outputTokens?: number | null;
}

// ---------------------------------------------------------------------------
// Polling context
// ---------------------------------------------------------------------------

export interface PollContext {
  batchId: BatchId;
  provider: ProviderName;
  submittedAt: Date;
  lastPolledAt: Date | null;
  pollCount: number;
  /** Provider's stated completion window (e.g., 24h from submission). */
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Analytics / telemetry
// ---------------------------------------------------------------------------

/** A date range for querying usage stats. */
export interface DateRange {
  from: Date;
  to: Date;
}

/** Aggregated usage statistics for a user over a time period. */
export interface UsageStats {
  totalRequests: number;
  succeededRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalBatches: number;
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

/** Entity types tracked in the event log. */
export type EventEntityType = "batch" | "request" | "result";

/** Fields required to create a new event log entry. */
export interface NewEvent {
  entityType: EventEntityType;
  entityId: string;
  event: string;
  details?: Record<string, unknown> | null;
}

/** Full event log record as stored in the database. */
export interface EventLogEntry {
  id: string;
  entityType: EventEntityType;
  entityId: string;
  event: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Health score (rate limiting)
// ---------------------------------------------------------------------------

export interface HealthScore {
  /** Value between 0.1 and 1.0. */
  factor: number;
  /** What's driving the score. */
  reason: "healthy" | "partial_failures" | "mostly_failing" | "critical";
}

// ---------------------------------------------------------------------------
// User limits (rate limiting / spend controls)
// ---------------------------------------------------------------------------

/** Per-user spend and rate limit configuration. */
export interface UserLimits {
  userId: string;
  /** Max requests allowed per rolling hour. NULL = unlimited. */
  maxRequestsPerHour: number | null;
  /** Max tokens allowed per rolling day. NULL = unlimited. */
  maxTokensPerDay: number | null;
  /** Absolute spend ceiling in USD. NULL = unlimited. */
  hardSpendLimitUsd: number | null;
  /** Requests consumed in the current period. */
  currentPeriodRequests: number;
  /** Tokens consumed in the current period. */
  currentPeriodTokens: number;
  /** Cumulative spend in USD. */
  currentSpendUsd: number;
  /** When the current period expires and counters reset. */
  periodResetAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields for creating or updating user limits. */
export interface UserLimitsInput {
  maxRequestsPerHour?: number | null;
  maxTokensPerDay?: number | null;
  hardSpendLimitUsd?: number | null;
}

// ---------------------------------------------------------------------------
// Sliding window (for health score computation)
// ---------------------------------------------------------------------------

/** Aggregated batch outcomes over a sliding time window. */
export interface SlidingWindow {
  /** Total batches completed in the window. */
  total: number;
  /** Batches that fully succeeded. */
  succeeded: number;
  /** Batches that partially or fully failed. */
  failed: number;
}

// ---------------------------------------------------------------------------
// Rate limit check result
// ---------------------------------------------------------------------------

/** Result of a rate limit check. */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** If rejected, the reason. */
  reason?: string;
  /** Seconds until the period resets (for Retry-After header). */
  retryAfterSeconds?: number;
  /** Current health score. */
  health?: HealthScore;
  /** Current effective limit. */
  effectiveLimit?: number;
}
