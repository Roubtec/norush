import type {
  Batch,
  DateRange,
  NewBatch,
  NewRequest,
  NewResult,
  Request,
  Result,
  UsageStats,
} from "../types.js";

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
  getRequest(id: string): Promise<Request | null>;

  /** Apply partial updates to a request record. */
  updateRequest(id: string, updates: Partial<Request>): Promise<void>;

  /** Fetch up to `limit` requests in 'queued' status, ordered by creation. */
  getQueuedRequests(limit: number): Promise<Request[]>;

  // -- Batch lifecycle ------------------------------------------------------

  /** Persist a new batch and return the full record with generated ID. */
  createBatch(batch: NewBatch): Promise<Batch>;

  /** Retrieve a batch by ID, or null if not found. */
  getBatch(id: string): Promise<Batch | null>;

  /** Apply partial updates to a batch record. */
  updateBatch(id: string, updates: Partial<Batch>): Promise<void>;

  /** Fetch all batches in 'pending' status (not yet submitted). */
  getPendingBatches(): Promise<Batch[]>;

  /** Fetch all batches that have been submitted but not yet completed. */
  getInFlightBatches(): Promise<Batch[]>;

  // -- Result lifecycle -----------------------------------------------------

  /** Persist a new result and return the full record with generated ID. */
  createResult(result: NewResult): Promise<Result>;

  /** Fetch up to `limit` results that have not yet been delivered. */
  getUndeliveredResults(limit: number): Promise<Result[]>;

  /** Mark a result as successfully delivered. */
  markDelivered(id: string): Promise<void>;

  // -- Retention ------------------------------------------------------------

  /** Remove prompt/response content from records older than `before`. Returns count of scrubbed records. */
  scrubExpiredContent(before: Date): Promise<number>;

  // -- Telemetry / analytics ------------------------------------------------

  /** Aggregate usage statistics for a user within a date range. */
  getStats(userId: string, period: DateRange): Promise<UsageStats>;
}
