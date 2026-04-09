import type {
  Batch,
  BatchId,
  DateRange,
  DetailedUsageStats,
  EventLogEntry,
  NewBatch,
  NewEvent,
  NewRequest,
  NewResult,
  NorushId,
  Request,
  Result,
  ResultId,
  SlidingWindow,
  UsageStats,
  UserLimits,
  UserLimitsInput,
} from "../types.js";

/**
 * The subset of Result fields that may be mutated after creation.
 *
 * Immutable fields (id, requestId, batchId, response, tokens, createdAt) are
 * excluded so all store implementations stay consistent — callers cannot
 * accidentally overwrite them via `updateResult()`.
 */
export interface ResultDeliveryUpdate {
  deliveryStatus?: Result["deliveryStatus"];
  deliveryAttempts?: number;
  maxDeliveryAttempts?: number;
  lastDeliveryError?: string | null;
  nextDeliveryAt?: Date | null;
  deliveredAt?: Date | null;
  contentScrubbedAt?: Date | null;
}

/**
 * Persistence layer interface.
 *
 * Abstracts all database operations for requests, batches, results, retention,
 * and analytics. The PostgresStore implementation (task 1-03) satisfies this.
 */
export interface Store {
  // -- Request lifecycle ----------------------------------------------------

  /** Persist a new request and return the full record with generated ID. */
  createRequest(req: NewRequest): Promise<Request>;

  /** Retrieve a request by ID, or null if not found. */
  getRequest(id: NorushId): Promise<Request | null>;

  /** Apply partial updates to a request record. */
  updateRequest(id: NorushId, updates: Partial<Request>): Promise<void>;

  /** Fetch up to `limit` requests in 'queued' status, ordered by creation. */
  getQueuedRequests(limit: number): Promise<Request[]>;

  /**
   * Atomically assign a batch to multiple requests and mark them as 'batched'.
   * More efficient than calling `updateRequest()` for each request individually.
   */
  assignBatchToRequests(
    ids: NorushId[],
    batchId: BatchId,
    status: "batched",
  ): Promise<void>;

  // -- API key lookup -------------------------------------------------------

  /**
   * Resolve the highest-priority API key ID for a user + provider pair.
   * Used by BatchManager to store the correct `user_api_keys.id` on a batch.
   * Returns null if no key is configured.
   */
  findApiKeyId(userId: string, provider: string): Promise<string | null>;

  // -- Batch lifecycle ------------------------------------------------------

  /** Persist a new batch and return the full record with generated ID. */
  createBatch(batch: NewBatch): Promise<Batch>;

  /** Retrieve a batch by ID, or null if not found. */
  getBatch(id: BatchId): Promise<Batch | null>;

  /** Apply partial updates to a batch record. */
  updateBatch(id: BatchId, updates: Partial<Batch>): Promise<void>;

  /** Fetch all batches in 'pending' status (not yet submitted). */
  getPendingBatches(): Promise<Batch[]>;

  /** Fetch all batches that have been submitted but not yet completed. */
  getInFlightBatches(): Promise<Batch[]>;

  /** Fetch all requests belonging to a specific batch. */
  getRequestsByBatchId(batchId: string): Promise<Request[]>;

  // -- Result lifecycle -----------------------------------------------------

  /** Persist a new result and return the full record with generated ID. */
  createResult(result: NewResult): Promise<Result>;

  /** Fetch up to `limit` results that have not yet been delivered. */
  getUndeliveredResults(limit: number): Promise<Result[]>;

  /** Apply delivery-tracking updates to a result record. */
  updateResult(id: string, updates: ResultDeliveryUpdate): Promise<void>;

  /** Mark a result as successfully delivered. */
  markDelivered(id: ResultId): Promise<void>;

  // -- Retention ------------------------------------------------------------

  /** Remove prompt/response content from records older than `before`. Returns count of scrubbed records. */
  scrubExpiredContent(before: Date): Promise<number>;

  // -- Event log ------------------------------------------------------------

  /** Write an entry to the event log. */
  logEvent(event: NewEvent): Promise<EventLogEntry>;

  // -- Telemetry / analytics ------------------------------------------------

  /** Aggregate usage statistics for a user within a date range. */
  getStats(userId: string, period: DateRange): Promise<UsageStats>;

  /** Aggregate detailed usage stats including cost breakdown and turnaround times. */
  getDetailedStats(userId: string, period: DateRange): Promise<DetailedUsageStats>;

  // -- User limits (rate limiting / spend controls) --------------------------

  /** Retrieve a user's rate limits, or null if none configured. */
  getUserLimits(userId: string): Promise<UserLimits | null>;

  /** Create or update a user's rate limits. Returns the full record. */
  upsertUserLimits(userId: string, input: UserLimitsInput): Promise<UserLimits>;

  /** Increment the user's period request counter by `count` (default 1). */
  incrementPeriodRequests(userId: string, count?: number): Promise<void>;

  /** Increment the user's period token counter by `count`. */
  incrementPeriodTokens(userId: string, count: number): Promise<void>;

  /** Increment the user's cumulative spend by `amountUsd`. */
  incrementSpend(userId: string, amountUsd: number): Promise<void>;

  /** Reset period counters for the user and advance the reset timestamp. */
  resetPeriod(userId: string, nextResetAt: Date): Promise<void>;

  /**
   * Compute a sliding window of batch outcomes for a user.
   * Returns counts of succeeded and failed batches within the window.
   */
  getSlidingWindow(userId: string, windowMs: number): Promise<SlidingWindow>;
}
