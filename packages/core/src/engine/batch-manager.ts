/**
 * Batch Manager.
 *
 * Reads queued requests from the store, groups them by
 * `(provider, model, api_key_id)`, splits groups that exceed provider limits,
 * and submits each batch to the appropriate provider adapter. Follows the
 * write-before-submit idempotency protocol:
 *
 *   1. Create batch record with `status: 'pending'`, `submission_attempts: 0`.
 *   2. Increment `submission_attempts` to 1, call provider.
 *   3. On success: update `provider_batch_id` and `status: 'submitted'`.
 *   4. On failure: leave `provider_batch_id` NULL — orphan candidate for
 *      the Status Tracker to recover later (task 1-07).
 */

import type { Store } from "../interfaces/store.js";
import type { Provider } from "../interfaces/provider.js";
import type { TelemetryHook } from "../interfaces/telemetry.js";
import type { BatchingConfig } from "../config/types.js";
import type {
  NorushRequest,
  ProviderName,
  Request,
} from "../types.js";
import { NoopTelemetry } from "../telemetry/noop.js";

// ---------------------------------------------------------------------------
// Provider size limits
// ---------------------------------------------------------------------------

export interface ProviderLimits {
  maxRequests: number;
  maxBytes: number;
}

export const PROVIDER_LIMITS: Record<ProviderName, ProviderLimits> = {
  claude: { maxRequests: 100_000, maxBytes: 256 * 1024 * 1024 },
  openai: { maxRequests: 50_000, maxBytes: 200 * 1024 * 1024 },
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BatchManagerOptions {
  store: Store;
  /** Map of provider name to API-key-ID to Provider adapter instance. */
  providers: Map<string, Provider>;
  batching: BatchingConfig;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
}

// ---------------------------------------------------------------------------
// Group key
// ---------------------------------------------------------------------------

/** Composite key for grouping requests into batches. */
function groupKey(provider: ProviderName, model: string, apiKeyId: string): string {
  return `${provider}::${model}::${apiKeyId}`;
}

// ---------------------------------------------------------------------------
// Batch Manager
// ---------------------------------------------------------------------------

export class BatchManager {
  private readonly store: Store;
  private readonly providers: Map<string, Provider>;
  private readonly batching: BatchingConfig;
  private readonly telemetry: TelemetryHook;

  constructor(options: BatchManagerOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.batching = options.batching;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Form batches from all queued requests and submit them.
   *
   * Steps:
   * 1. Fetch queued requests from the store.
   * 2. Group by `(provider, model, api_key_id)`.
   * 3. Split groups exceeding provider limits.
   * 4. For each batch: write-before-submit, then call provider.
   */
  async flush(): Promise<void> {
    const queued = await this.store.getQueuedRequests(this.batching.maxRequests);
    if (queued.length === 0) return;

    const groups = this.groupRequests(queued);

    for (const [, requests] of groups) {
      const chunks = this.splitByProviderLimits(requests);

      for (const chunk of chunks) {
        await this.submitBatch(chunk);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Group requests by `(provider, model, api_key_id)`.
   *
   * The `api_key_id` is derived from the request's `userId` field, which is
   * the key isolation boundary per PLAN.md Section 6.1. In a multi-tenant
   * deployment, the userId maps to a specific API key via the key vault.
   * For now, we group by userId as the key boundary; the engine entry point
   * (task 1-09) will resolve userId -> apiKeyId.
   */
  private groupRequests(requests: Request[]): Map<string, Request[]> {
    const groups = new Map<string, Request[]>();

    for (const req of requests) {
      // Use userId as the api_key_id proxy for grouping.
      const key = groupKey(req.provider, req.model, req.userId);
      const group = groups.get(key);
      if (group) {
        group.push(req);
      } else {
        groups.set(key, [req]);
      }
    }

    return groups;
  }

  /**
   * Split a group of requests into chunks that respect provider limits.
   *
   * Each chunk is guaranteed to be within the provider's max request count
   * and max byte size.
   */
  private splitByProviderLimits(requests: Request[]): Request[][] {
    if (requests.length === 0) return [];

    const provider = requests[0].provider;
    const limits = PROVIDER_LIMITS[provider];
    const chunks: Request[][] = [];
    let currentChunk: Request[] = [];
    let currentBytes = 0;

    for (const req of requests) {
      const reqBytes = new TextEncoder().encode(
        JSON.stringify(req.params),
      ).byteLength;

      const wouldExceedCount = currentChunk.length >= limits.maxRequests;
      const wouldExceedBytes = currentBytes + reqBytes > limits.maxBytes;

      if (currentChunk.length > 0 && (wouldExceedCount || wouldExceedBytes)) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }

      currentChunk.push(req);
      currentBytes += reqBytes;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Submit a single batch following the write-before-submit protocol.
   *
   * 1. Create batch record with `status: 'pending'`.
   * 2. Increment `submission_attempts`, call provider.
   * 3. On success: update to `submitted` with `provider_batch_id`.
   * 4. On failure: leave `provider_batch_id` NULL.
   */
  private async submitBatch(requests: Request[]): Promise<void> {
    const provider = requests[0].provider;
    const userId = requests[0].userId;

    // Resolve the provider adapter. Key is "provider::userId".
    const adapterKey = `${provider}::${userId}`;
    const adapter = this.providers.get(adapterKey) ?? this.providers.get(provider);

    if (!adapter) {
      this.telemetry.event("batch_submit_error", {
        provider,
        userId,
        error: `No provider adapter found for ${adapterKey}`,
      });
      return;
    }

    // Step 1: Write batch record (write-before-submit).
    const batch = await this.store.createBatch({
      provider,
      apiKeyId: userId,
      requestCount: requests.length,
    });

    // Update all requests to reference this batch and mark as 'batched'.
    for (const req of requests) {
      await this.store.updateRequest(req.id, {
        batchId: batch.id,
        status: "batched",
      });
    }

    // Step 2: Increment submission_attempts and call provider.
    await this.store.updateBatch(batch.id, {
      submissionAttempts: 1,
    });

    // Build NorushRequest payloads for the provider.
    const norushRequests: NorushRequest[] = requests.map((req) => ({
      id: req.id,
      externalId: req.externalId ?? req.id,
      provider: req.provider,
      model: req.model,
      params: req.params,
    }));

    try {
      const ref = await adapter.submitBatch(norushRequests);

      // Step 3: Success — update batch with provider reference.
      await this.store.updateBatch(batch.id, {
        providerBatchId: ref.providerBatchId,
        status: "submitted",
        submittedAt: new Date(),
      });

      this.telemetry.counter("batches_submitted", 1, {
        provider,
        status: "success",
      });

      this.telemetry.event("batch_submitted", {
        batchId: batch.id,
        provider,
        providerBatchId: ref.providerBatchId,
        requestCount: requests.length,
      });
    } catch (error) {
      // Step 4: Failure — leave provider_batch_id NULL.
      // The batch remains in 'pending' status for orphan recovery (task 1-07).
      this.telemetry.counter("batches_submitted", 1, {
        provider,
        status: "failure",
      });

      this.telemetry.event("batch_submit_error", {
        batchId: batch.id,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
