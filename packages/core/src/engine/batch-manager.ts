/**
 * Batch Manager.
 *
 * Reads queued requests from the store, groups them by
 * `(provider, model, userId)`, splits groups that exceed provider limits,
 * and submits each batch to the appropriate provider adapter. Follows the
 * write-before-submit idempotency protocol:
 *
 *   1. Create batch record with `status: 'pending'`, `submission_attempts: 0`.
 *   2. Increment `submission_attempts` to 1, call provider.
 *   3. On success: update `provider_batch_id` and `status: 'submitted'`.
 *   4. On failure: leave `provider_batch_id` NULL — orphan candidate for
 *      the Status Tracker to recover later (task 1-07).
 *
 * Multi-token failover (task 3-03):
 *   When a `KeyResolver` is provided, the batch manager loads the user's
 *   keys for each provider, ordered by priority. On submission failure due
 *   to rate limiting (429) or credit exhaustion, it automatically falls back
 *   to the next key. The key used is recorded on the batch record.
 */

import type { Store } from '../interfaces/store.js';
import type { Provider } from '../interfaces/provider.js';
import type { TelemetryHook } from '../interfaces/telemetry.js';
import type { BatchingConfig } from '../config/types.js';
import type { NorushRequest, ProviderName, Request } from '../types.js';
import { NoopTelemetry } from '../telemetry/noop.js';
import { selectKeys, isFailoverEligibleError, type ApiKeyInfo } from '../keys/selector.js';

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
// Key Resolver interface
// ---------------------------------------------------------------------------

/**
 * Resolves API keys for a user + provider combination.
 *
 * The batch manager calls this at submission time to get ordered key
 * candidates. The implementation (in the web layer) queries the
 * `user_api_keys` table and returns key metadata.
 */
export interface KeyResolver {
  /**
   * Return all active (non-revoked) API keys for a user + provider pair.
   * Keys should include priority and failover_enabled fields.
   */
  getKeysForUser(userId: string, provider: ProviderName): Promise<ApiKeyInfo[]>;

  /**
   * Build a Provider adapter instance for a given API key ID.
   * Called at submission time so decryption happens just-in-time.
   */
  buildProvider(keyId: string, provider: ProviderName): Promise<Provider>;
}

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
  /**
   * Optional key resolver for multi-token failover.
   * When provided, the batch manager will load keys per user/provider and
   * try them in priority order, falling back on rate-limit / credit errors.
   */
  keyResolver?: KeyResolver;
}

// ---------------------------------------------------------------------------
// Group key
// ---------------------------------------------------------------------------

/** Composite key for grouping requests into batches. */
function groupKey(provider: ProviderName, model: string, userId: string): string {
  return `${provider}::${model}::${userId}`;
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
  private readonly keyResolver: KeyResolver | null;

  /** Guard to prevent concurrent flushes creating duplicate batches. */
  private flushing = false;

  constructor(options: BatchManagerOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.batching = options.batching;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
    this.limits = options.providerLimits ?? PROVIDER_LIMITS;
    this.keyResolver = options.keyResolver ?? null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Form batches from all queued requests and submit them.
   *
   * Steps:
   * 1. Fetch queued requests from the store.
   * 2. Group by `(provider, model, userId)`.
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
   * Group requests by `(provider, model, userId)`.
   *
   * The `userId` field is the key isolation boundary per PLAN.md Section 6.1.
   * When a KeyResolver is present, actual key selection happens at submit time.
   */
  private groupRequests(requests: Request[]): Map<string, Request[]> {
    const groups = new Map<string, Request[]>();

    for (const req of requests) {
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
      const reqBytes = new TextEncoder().encode(JSON.stringify(req.params)).byteLength;

      // A request whose params alone exceed the limit can never fit in a batch.
      if (reqBytes > limits.maxBytes) {
        this.telemetry.event('request_oversized', {
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
   * Submit a single batch following the write-before-submit protocol,
   * with multi-token failover when a KeyResolver is available.
   */
  private async submitBatch(requests: Request[]): Promise<void> {
    const provider = requests[0].provider;
    const userId = requests[0].userId;

    // If we have a key resolver, use failover-aware submission.
    const resolver = this.keyResolver;
    if (resolver) {
      await this.submitWithFailover(requests, provider, userId, resolver);
      return;
    }

    // Legacy path: resolve adapter from provider map.
    await this.submitWithLegacyProvider(requests, provider, userId);
  }

  /**
   * Legacy provider-map based submission (no failover).
   *
   * On failure, leaves the batch in pending status with NULL provider_batch_id
   * for orphan recovery (task 1-07) to handle.
   */
  private async submitWithLegacyProvider(
    requests: Request[],
    provider: ProviderName,
    userId: string,
  ): Promise<void> {
    // Resolve the provider adapter. Key is "provider::userId".
    const adapterKey = `${provider}::${userId}`;
    const adapter = this.providers.get(adapterKey) ?? this.providers.get(provider);

    if (!adapter) {
      this.telemetry.event('batch_submit_error', {
        provider,
        userId,
        error: `No provider adapter found for ${adapterKey}`,
      });
      return;
    }

    // Look up the real user_api_keys.id so batches.api_key_id satisfies the FK.
    // Falls back to userId for environments (e.g. tests) where no key row exists.
    const apiKeyId = (await this.store.findApiKeyId(userId, provider)) ?? userId;

    // Step 1: Write batch record (write-before-submit).
    const batch = await this.store.createBatch({
      provider,
      apiKeyId,
      requestCount: requests.length,
    });

    // Update all requests to reference this batch and mark as 'batched'.
    await this.store.assignBatchToRequests(
      requests.map((req) => req.id),
      batch.id,
      'batched',
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
        status: 'submitted',
        submittedAt: new Date(),
      });

      this.telemetry.counter('batches_submitted', 1, {
        provider,
        status: 'success',
      });

      this.telemetry.event('batch_submitted', {
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
          this.store.updateRequest(req.id, { batchId: null, status: 'queued' }),
        ),
      );

      this.telemetry.counter('batches_submitted', 1, {
        provider,
        status: 'failure',
      });

      this.telemetry.event('batch_submit_error', {
        batchId: batch.id,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Failover-aware submission: try keys in priority order, falling back
   * on rate-limit / credit errors.
   *
   * Each submission attempt follows the normal write-before-submit protocol,
   * so a batch record is created before each provider call. During failover,
   * multiple batch records may be created. Batches from failover-eligible
   * failures (rate-limit / credit) are marked failed and requests reset to
   * queued for the next attempt. Batches from non-failover errors are left
   * in pending (NULL provider_batch_id) for orphan recovery (task 1-07).
   */
  private async submitWithFailover(
    requests: Request[],
    provider: ProviderName,
    userId: string,
    resolver: KeyResolver,
  ): Promise<void> {
    const keys = await resolver.getKeysForUser(userId, provider);
    const candidates = selectKeys(keys);

    if (candidates.length === 0) {
      this.telemetry.event('batch_submit_error', {
        provider,
        userId,
        error: 'No active API keys found for user/provider',
      });
      return;
    }

    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      try {
        const adapter = await resolver.buildProvider(candidate.id, provider);

        await this.submitBatchWithAdapter(
          requests,
          adapter,
          provider,
          candidate.id,
          candidate.label,
        );

        // Success — record telemetry if failover was used.
        if (i > 0) {
          this.telemetry.event('failover_used', {
            provider,
            userId,
            fromKeyId: candidates[0].id,
            toKeyId: candidate.id,
            attemptIndex: i,
          });
        }
        return;
      } catch (error) {
        lastError = error;

        // Only failover on rate-limit / credit errors.
        if (!isFailoverEligibleError(error)) {
          // Non-failover error: stop trying. The batch has already been
          // created and left in pending for orphan recovery.
          this.telemetry.event('batch_submit_error', {
            provider,
            userId,
            keyId: candidate.id,
            error: error instanceof Error ? error.message : String(error),
            failoverEligible: false,
          });
          return;
        }

        // Log the failover attempt.
        this.telemetry.event('failover_attempt', {
          provider,
          userId,
          keyId: candidate.id,
          error: error instanceof Error ? error.message : String(error),
          nextKeyIndex: i + 1,
          totalCandidates: candidates.length,
        });
      }
    }

    // All keys exhausted — log and return.
    this.telemetry.event('batch_submit_error', {
      provider,
      userId,
      error: 'All API keys exhausted during failover',
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
      keysAttempted: candidates.length,
    });
  }

  /**
   * Submit a batch with a specific adapter, following write-before-submit.
   *
   * Used by the failover path. On failure, resets requests back to queued
   * and marks the batch as failed, then re-throws so the failover loop
   * can try the next key.
   */
  private async submitBatchWithAdapter(
    requests: Request[],
    adapter: Provider,
    provider: ProviderName,
    apiKeyId: string,
    apiKeyLabel?: string,
  ): Promise<void> {
    // Step 1: Write batch record (write-before-submit).
    const batch = await this.store.createBatch({
      provider,
      apiKeyId,
      apiKeyLabel: apiKeyLabel ?? null,
      requestCount: requests.length,
    });

    // Update all requests to reference this batch and mark as 'batched'.
    for (const req of requests) {
      await this.store.updateRequest(req.id, {
        batchId: batch.id,
        status: 'batched',
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
        status: 'submitted',
        submittedAt: new Date(),
      });

      this.telemetry.counter('batches_submitted', 1, {
        provider,
        status: 'success',
      });

      this.telemetry.event('batch_submitted', {
        batchId: batch.id,
        provider,
        providerBatchId: ref.providerBatchId,
        requestCount: requests.length,
        apiKeyId,
        ...(apiKeyLabel ? { apiKeyLabel } : {}),
      });
    } catch (error) {
      if (isFailoverEligibleError(error)) {
        // Rate-limit / credit error: reset requests to queued so the next
        // key attempt can re-batch them, and mark this batch as failed.
        for (const req of requests) {
          await this.store.updateRequest(req.id, {
            batchId: null,
            status: 'queued',
          });
        }
        await this.store.updateBatch(batch.id, {
          status: 'failed',
        });
      }
      // Non-failover error (network, 500, etc.): leave batch in 'pending' with
      // NULL provider_batch_id for orphan recovery (task 1-07). Requests remain
      // 'batched' to avoid duplicate submissions — the provider may have accepted
      // the batch even though an error was thrown on our end.

      this.telemetry.counter('batches_submitted', 1, {
        provider,
        status: 'failure',
      });

      this.telemetry.event('batch_submit_error', {
        batchId: batch.id,
        provider,
        apiKeyId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Re-throw so the failover loop can catch and try the next key.
      throw error;
    }
  }
}
