/**
 * Result Ingester — Phase A of the Result Pipeline.
 *
 * Streams results from a provider one at a time and persists each to the store
 * immediately. Crash-safe: if the process dies mid-ingestion, already-persisted
 * results survive. On restart, duplicate results (same request_id) are handled
 * gracefully via idempotent upsert logic.
 *
 * Called when a batch reaches terminal status (`ended`). The ingester:
 *   1. Calls `provider.fetchResults(ref)` which returns `AsyncIterable<NorushResult>`.
 *   2. For each result: `store.createResult()` immediately.
 *   3. Updates the corresponding request status (`succeeded` or `failed`).
 *   4. Updates batch-level succeeded/failed counters.
 */

import type { Store } from "../interfaces/store.js";
import type { Provider } from "../interfaces/provider.js";
import type { TelemetryHook } from "../interfaces/telemetry.js";
import type { Batch, ProviderBatchRef } from "../types.js";
import { NoopTelemetry } from "../telemetry/noop.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResultIngesterOptions {
  store: Store;
  /** Map of provider name (or "provider::apiKeyId") to Provider adapter. */
  providers: Map<string, Provider>;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
}

// ---------------------------------------------------------------------------
// Ingestion outcome
// ---------------------------------------------------------------------------

export interface IngestionResult {
  /** Total results ingested (persisted to store). */
  ingested: number;
  /** Results that succeeded at the provider level. */
  succeeded: number;
  /** Results that failed at the provider level. */
  failed: number;
  /** Results skipped because they were already persisted (duplicates). */
  duplicates: number;
  /** Errors encountered during ingestion (non-fatal). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Result Ingester
// ---------------------------------------------------------------------------

export class ResultIngester {
  private readonly store: Store;
  private readonly providers: Map<string, Provider>;
  private readonly telemetry: TelemetryHook;

  constructor(options: ResultIngesterOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
  }

  /**
   * Ingest all results for a completed batch.
   *
   * Streams results from the provider and persists each one immediately.
   * Returns a summary of what was ingested.
   */
  async ingest(batch: Batch): Promise<IngestionResult> {
    const result: IngestionResult = {
      ingested: 0,
      succeeded: 0,
      failed: 0,
      duplicates: 0,
      errors: [],
    };

    if (!batch.providerBatchId) {
      result.errors.push(`Batch ${batch.id} has no provider batch ID`);
      return result;
    }

    const ref: ProviderBatchRef = {
      providerBatchId: batch.providerBatchId,
      provider: batch.provider,
    };

    const adapter = this.resolveAdapter(batch.provider, batch.apiKeyId);
    if (!adapter) {
      result.errors.push(
        `No provider adapter found for ${batch.provider}::${batch.apiKeyId}`,
      );
      return result;
    }

    let succeededCount = batch.succeededCount;
    let failedCount = batch.failedCount;

    for await (const norushResult of adapter.fetchResults(ref)) {
      try {
        // Persist result to store immediately (crash-safe).
        await this.store.createResult({
          requestId: norushResult.requestId,
          batchId: batch.id,
          response: norushResult.response,
          stopReason: norushResult.stopReason ?? null,
          inputTokens: norushResult.inputTokens ?? null,
          outputTokens: norushResult.outputTokens ?? null,
        });

        // Update the corresponding request status.
        const newStatus = norushResult.success ? "succeeded" : "failed";
        await this.store.updateRequest(norushResult.requestId, {
          status: newStatus,
        });

        if (norushResult.success) {
          result.succeeded++;
          succeededCount++;
        } else {
          result.failed++;
          failedCount++;
        }

        result.ingested++;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        // Check for duplicate (request_id uniqueness constraint).
        if (isDuplicateError(message)) {
          result.duplicates++;
          this.telemetry.event("result_duplicate_skipped", {
            requestId: norushResult.requestId,
            batchId: batch.id,
          });
        } else {
          result.errors.push(
            `Failed to ingest result for request ${norushResult.requestId}: ${message}`,
          );
          this.telemetry.event("result_ingestion_error", {
            requestId: norushResult.requestId,
            batchId: batch.id,
            error: message,
          });
        }
      }
    }

    // Update batch-level counters.
    await this.store.updateBatch(batch.id, {
      succeededCount,
      failedCount,
    });

    this.telemetry.counter("results_ingested", result.ingested, {
      provider: batch.provider,
      batchId: batch.id,
    });

    if (result.failed > 0) {
      this.telemetry.counter("results_failed", result.failed, {
        provider: batch.provider,
        batchId: batch.id,
      });
    }

    this.telemetry.event("ingestion_complete", {
      batchId: batch.id,
      ingested: result.ingested,
      succeeded: result.succeeded,
      failed: result.failed,
      duplicates: result.duplicates,
      errors: result.errors.length,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Provider adapter resolution
  // -------------------------------------------------------------------------

  private resolveAdapter(
    provider: string,
    apiKeyId: string,
  ): Provider | undefined {
    return (
      this.providers.get(`${provider}::${apiKeyId}`) ??
      this.providers.get(provider)
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic to detect duplicate-key errors from various stores.
 * MemoryStore won't throw on duplicate requestId by default, but
 * PostgresStore will throw a unique constraint violation.
 */
function isDuplicateError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("duplicate") ||
    lower.includes("unique constraint") ||
    lower.includes("unique_violation") ||
    lower.includes("already exists")
  );
}
