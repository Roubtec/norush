/**
 * Request Queue.
 *
 * Accepts individual requests, assigns a ULID `norush_id`, persists them to
 * the store with `status: 'queued'`, and triggers batch flush when configured
 * thresholds are met (count, byte size, or time interval).
 *
 * Flush triggers are driven by the `BatchingConfig`:
 *   - `maxRequests`   — flush when the in-memory count reaches this.
 *   - `maxBytes`      — flush when cumulative serialized size reaches this.
 *   - `flushIntervalMs` — periodic timer-based flush.
 *
 * The queue delegates batch formation and submission to a flush callback
 * (typically the Batch Manager's `flush()` method).
 */

import type { Store } from "../interfaces/store.js";
import type { TelemetryHook } from "../interfaces/telemetry.js";
import type { BatchingConfig } from "../config/types.js";
import type { NewRequest, Request } from "../types.js";
import { NoopTelemetry } from "../telemetry/noop.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RequestQueueOptions {
  store: Store;
  batching: BatchingConfig;
  /** Called when a flush trigger fires. Typically `batchManager.flush()`. */
  onFlush: () => Promise<void>;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export class RequestQueue {
  private readonly store: Store;
  private readonly batching: BatchingConfig;
  private readonly onFlush: () => Promise<void>;
  private readonly telemetry: TelemetryHook;

  /** Pending request count since last flush (used for count trigger). */
  private pendingCount = 0;

  /** Cumulative serialized bytes since last flush (used for byte trigger). */
  private pendingBytes = 0;

  /** Interval handle for time-based flush. Null when not started. */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Guard to prevent concurrent flushes. */
  private flushing = false;

  constructor(options: RequestQueueOptions) {
    this.store = options.store;
    this.batching = options.batching;
    this.onFlush = options.onFlush;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Accept a request, persist it, and check flush triggers.
   *
   * Returns the persisted request record (with assigned ULID and
   * `status: 'queued'`).
   */
  async enqueue(request: NewRequest): Promise<Request> {
    const record = await this.store.createRequest(request);
    this.telemetry.counter("requests_queued", 1, {
      provider: record.provider,
      model: record.model,
    });

    // Track pending counters for flush trigger evaluation.
    this.pendingCount++;
    this.pendingBytes += estimateBytes(request);

    await this.checkFlushTriggers();
    return record;
  }

  /**
   * Force an immediate flush regardless of thresholds.
   */
  async flush(): Promise<void> {
    await this.triggerFlush();
  }

  /**
   * External tick — call this from a cron/scheduler instead of relying on
   * the internal `setInterval`. Always attempts a flush so persisted queued
   * requests are not skipped when in-memory counters are zero (for example,
   * after a process restart or a previous flush error).
   */
  async tick(): Promise<void> {
    await this.triggerFlush();
  }

  /**
   * Start the periodic flush timer (if `flushIntervalMs > 0`).
   * Idempotent — calling start() multiple times is safe.
   */
  start(): void {
    if (this.flushTimer !== null || this.batching.flushIntervalMs <= 0) return;
    this.flushTimer = setInterval(() => {
      // Fire-and-forget but catch errors to avoid unhandled rejection.
      void this.tick().catch(() => {
        /* swallow — telemetry will have captured the error in onFlush */
      });
    }, this.batching.flushIntervalMs);
    // Unref so the timer doesn't prevent process exit.
    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  /**
   * Stop the periodic flush timer and optionally perform a final flush.
   */
  async stop(options?: { finalFlush?: boolean }): Promise<void> {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (options?.finalFlush && this.pendingCount > 0) {
      await this.triggerFlush();
    }
  }

  /**
   * Current count of requests enqueued since the last flush.
   * Useful for testing and observability.
   */
  get pending(): { count: number; bytes: number } {
    return { count: this.pendingCount, bytes: this.pendingBytes };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async checkFlushTriggers(): Promise<void> {
    if (this.pendingCount >= this.batching.maxRequests) {
      await this.triggerFlush();
      return;
    }
    if (this.pendingBytes >= this.batching.maxBytes) {
      await this.triggerFlush();
    }
  }

  private async triggerFlush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    // Snapshot counters so that requests arriving *during* the flush are
    // counted toward the next cycle. On error the counters are left unchanged
    // so that the next tick or threshold check will retry.
    const flushedCount = this.pendingCount;
    const flushedBytes = this.pendingBytes;
    try {
      await this.onFlush();
      this.pendingCount = Math.max(0, this.pendingCount - flushedCount);
      this.pendingBytes = Math.max(0, this.pendingBytes - flushedBytes);
    } finally {
      this.flushing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the serialized byte size of a request's params payload.
 *
 * This is a fast heuristic — `JSON.stringify` is accurate but potentially
 * expensive for very large payloads. For the queue's threshold check this
 * is good enough; the Batch Manager does a precise measurement when
 * splitting batches.
 */
export function estimateBytes(request: NewRequest): number {
  // JSON.stringify is the most portable and accurate approach.
  // For queue threshold checking, this is called once per enqueue, which is
  // acceptable. The params object is typically a few KB.
  return new TextEncoder().encode(JSON.stringify(request.params)).byteLength;
}
