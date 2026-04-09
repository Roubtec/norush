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

export const PROVIDER_LIMITS = Object.freeze({
  claude: Object.freeze({ maxRequests: 100_000, maxBytes: 256 * 1024 * 1024 }),
  openai: Object.freeze({ maxRequests: 50_000, maxBytes: 200 * 1024 * 1024 }),
} as const) as Readonly<Record<ProviderName, Readonly<ProviderLimits>>>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BatchManagerOptions {
  store: Store;
  /**
   * Map of adapter lookup keys to Provider adapter instances.
   * Each key is either `"provider::userId"` (per-user adapter) or
   * `"provider"` (shared fallback). The manager tries the specific key first,
   * then falls back to the provider-only key.
   */
  providers: Map<string, Provider>;
  batching: BatchingConfig;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
  /**
   * Override provider size limits. Defaults to `PROVIDER_LIMITS`.
   * Primarily useful for testing without mutating the global constant.
   */
  providerLimits?: Record<ProviderName, ProviderLimits>;
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
  private readonly limits: Record<ProviderName, ProviderLimits>;

  /** Guard to prevent concurrent flushes creating duplicate batches. */
  private flushing = false;

  constructor(options: BatchManagerOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.batching = options.batching;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
    this.limits = options.providerLimits ?? PROVIDER_LIMITS;
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
    if (this.flushing) return;
    this.flushing = true;
    try {
      const queued = await this.store.getQueuedRequests(this.batching.maxRequests);
      if (queued.length === 0) return;

      const groups = this.groupRequests(queued);

      for (const [, requests] of groups) {
        const chunks = this.splitByProviderLimits(requests);

        for (const chunk of chunks) {
          await this.submitBatch(chunk);
        }
      }
    } finally {
      this.flushing = false;
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
   * and max byte size. Requests whose `params` exceed the provider's byte
   * limit on their own are skipped with a telemetry event — they cannot fit
   * in any batch.
   */
  private splitByProviderLimits(requests: Request[]): Request[][] {
    if (requests.length === 0) return [];

    const provider = requests[0].provider;
    const limits = this.limits[provider];
    const chunks: Request[][] = [];
    let currentChunk: Request[] = [];
    let currentBytes = 0;

    for (const req of requests) {
      const reqBytes = new TextEncoder().encode(
        JSON.stringify(req.params),
      ).byteLength;

      // A request whose params alone exceed the limit can never fit in a batch.
      if (reqBytes > limits.maxBytes) {
        this.telemetry.event("request_oversized", {
          requestId: req.id,
          provider,
          reqBytes,
          limitBytes: limits.maxBytes,
        });
        continue;
      }

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
    await this.store.assignBatchToRequests(
      requests.map((req) => req.id),
      batch.id,
      "batched",
    );

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
      // Step 4: Failure — revert requests to 'queued' so they will be retried
      // on the next flush. The batch record stays in 'pending' with a NULL
      // providerBatchId for observability / orphan tracking (task 1-07).
      await Promise.all(
        requests.map((req) =>
          this.store.updateRequest(req.id, { batchId: null, status: "queued" }),
        ),
      );

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
