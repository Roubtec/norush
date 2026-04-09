/**
 * Repackager — Automatic retry for failed/expired requests.
 *
 * After result ingestion completes for a batch, the repackager scans its
 * requests for `status: 'failed'` or `status: 'expired'`. Eligible requests
 * (where `retryCount < maxRetries`) are re-queued by setting their status
 * back to `queued` and incrementing `retryCount`. These re-queued requests
 * will be picked up by the Batch Manager on the next flush.
 *
 * Requests exceeding the retry budget transition to `status: 'failed_final'`.
 */

import type { Store } from "../interfaces/store.js";
import type { TelemetryHook } from "../interfaces/telemetry.js";
import type { Batch, RequestStatus } from "../types.js";
import { NoopTelemetry } from "../telemetry/noop.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RepackagerOptions {
  store: Store;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
}

// ---------------------------------------------------------------------------
// Repackaging outcome
// ---------------------------------------------------------------------------

export interface RepackageResult {
  /** Number of requests re-queued for retry. */
  requeued: number;
  /** Number of requests that exceeded retry budget and became failed_final. */
  exhausted: number;
  /** Total requests scanned (failed + expired). */
  scanned: number;
}

// ---------------------------------------------------------------------------
// Eligible statuses for repackaging
// ---------------------------------------------------------------------------

const REPACKAGEABLE_STATUSES: Set<RequestStatus> = new Set([
  "failed",
  "expired",
]);

// ---------------------------------------------------------------------------
// Repackager
// ---------------------------------------------------------------------------

export class Repackager {
  private readonly store: Store;
  private readonly telemetry: TelemetryHook;

  constructor(options: RepackagerOptions) {
    this.store = options.store;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
  }

  /**
   * Scan a batch's requests and repackage eligible failed/expired ones.
   *
   * @param batch - The batch whose requests to scan.
   * @returns Summary of repackaging actions taken.
   */
  async repackage(batch: Batch): Promise<RepackageResult> {
    const result: RepackageResult = {
      requeued: 0,
      exhausted: 0,
      scanned: 0,
    };

    const requests = await this.store.getRequestsByBatchId(batch.id);

    for (const request of requests) {
      if (!REPACKAGEABLE_STATUSES.has(request.status)) {
        continue;
      }

      result.scanned++;

      if (request.retryCount < request.maxRetries) {
        // Re-queue for retry: increment retryCount, reset status to 'queued',
        // clear batchId so it gets picked up by the next flush.
        await this.store.updateRequest(request.id, {
          status: "queued",
          retryCount: request.retryCount + 1,
          batchId: null,
        });
        result.requeued++;
      } else {
        // Retry budget exhausted — mark as permanently failed.
        await this.store.updateRequest(request.id, {
          status: "failed_final",
        });
        result.exhausted++;
      }
    }

    if (result.requeued > 0 || result.exhausted > 0) {
      this.telemetry.counter("requests_requeued", result.requeued, {
        batchId: batch.id,
        provider: batch.provider,
      });
      this.telemetry.counter("requests_exhausted", result.exhausted, {
        batchId: batch.id,
        provider: batch.provider,
      });
    }

    this.telemetry.event("repackage_complete", {
      batchId: batch.id,
      scanned: result.scanned,
      requeued: result.requeued,
      exhausted: result.exhausted,
    });

    return result;
  }
}
