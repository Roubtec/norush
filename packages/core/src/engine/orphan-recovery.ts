/**
 * Orphan recovery.
 *
 * Detects batches that were written to the store (status: 'pending',
 * provider_batch_id: NULL) but never successfully submitted — typically due
 * to a process crash between the write-before-submit step and the provider
 * API call returning.
 *
 * Criteria for orphan detection:
 *   - status = 'pending'
 *   - providerBatchId IS NULL
 *   - updatedAt < now - gracePeriodMs (default 5 min)
 *   - submissionAttempts < maxSubmissionAttempts
 *
 * Orphans that exceed maxSubmissionAttempts are transitioned to 'failed'.
 */

import type { Store } from '../interfaces/store.js';
import type { Provider } from '../interfaces/provider.js';
import type { TelemetryHook } from '../interfaces/telemetry.js';
import type { Batch, NorushRequest, ProviderName } from '../types.js';
import { NoopTelemetry } from '../telemetry/noop.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanRecoveryOptions {
  store: Store;
  /** Map of provider name (or "provider::apiKeyId") to Provider adapter. */
  providers: Map<string, Provider>;
  /** Grace period in ms before a pending batch is considered orphaned. Default: 300_000 (5 min). */
  gracePeriodMs?: number;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
  /** Clock function for testability. */
  now?: () => Date;
}

export interface OrphanRecoveryResult {
  /** Number of orphans successfully re-submitted. */
  recovered: number;
  /** Number of orphans that exceeded max attempts and were marked failed. */
  failed: number;
}

// ---------------------------------------------------------------------------
// Orphan recovery
// ---------------------------------------------------------------------------

export class OrphanRecovery {
  /** Process-wide set of batch IDs currently being recovered, to prevent concurrent resubmission. */
  private static readonly inFlightRecoveryBatchIds = new Set<string>();

  private readonly store: Store;
  private readonly providers: Map<string, Provider>;
  private readonly gracePeriodMs: number;
  private readonly telemetry: TelemetryHook;
  private readonly now: () => Date;

  constructor(options: OrphanRecoveryOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.gracePeriodMs = options.gracePeriodMs ?? 300_000;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Scan for orphaned batches and attempt re-submission.
   *
   * Returns a summary of how many were recovered vs permanently failed.
   */
  async recover(): Promise<OrphanRecoveryResult> {
    const pending = await this.store.getPendingBatches();
    const cutoff = new Date(this.now().getTime() - this.gracePeriodMs);

    let recovered = 0;
    let failed = 0;

    for (const batch of pending) {
      // Only consider batches with no provider batch id (orphan candidates).
      if (batch.providerBatchId !== null) continue;

      // Only consider batches older than the grace period.
      if (batch.updatedAt >= cutoff) continue;

      if (batch.submissionAttempts >= batch.maxSubmissionAttempts) {
        // Exceeded max attempts — transition to failed.
        await this.markOrphanFailed(batch);
        failed++;
        continue;
      }

      // Attempt re-submission.
      const success = await this.resubmit(batch);
      if (success) {
        recovered++;
      } else {
        // Check if this failure pushed it over the limit.
        const updated = await this.store.getBatch(batch.id);
        if (updated && updated.submissionAttempts >= updated.maxSubmissionAttempts) {
          await this.markOrphanFailed(updated);
          failed++;
        }
      }
    }

    return { recovered, failed };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Attempt to re-submit an orphaned batch.
   *
   * Claims the batch for in-process recovery to prevent concurrent resubmission,
   * increments submissionAttempts, then calls the provider. On success, updates
   * with providerBatchId and status 'submitted'. On failure, leaves the batch in
   * 'pending' for the next recovery cycle.
   */
  private async resubmit(batch: Batch): Promise<boolean> {
    if (!this.claimBatchForRecovery(batch.id)) {
      this.telemetry.event('orphan_recovery_skipped', {
        batchId: batch.id,
        provider: batch.provider,
        reason: 'recovery_already_in_progress',
      });
      return false;
    }

    try {
      const adapter = this.resolveAdapter(batch.provider, batch.apiKeyId);
      if (!adapter) {
        this.telemetry.event('orphan_recovery_error', {
          batchId: batch.id,
          error: `No provider adapter found for ${batch.provider}`,
        });
        return false;
      }

      // Increment submission attempts.
      await this.store.updateBatch(batch.id, {
        submissionAttempts: batch.submissionAttempts + 1,
      });

      // Gather the requests for this batch.
      const requests = await this.buildNorushRequests(batch.id);
      if (requests.length === 0) {
        this.telemetry.event('orphan_recovery_error', {
          batchId: batch.id,
          error: 'No requests found for orphaned batch',
        });
        return false;
      }

      try {
        const ref = await adapter.submitBatch(requests);

        await this.store.updateBatch(batch.id, {
          providerBatchId: ref.providerBatchId,
          status: 'submitted',
          submittedAt: this.now(),
        });

        this.telemetry.event('orphan_recovered', {
          batchId: batch.id,
          provider: batch.provider,
          providerBatchId: ref.providerBatchId,
          submissionAttempts: batch.submissionAttempts + 1,
        });

        return true;
      } catch (error) {
        this.telemetry.event('orphan_recovery_error', {
          batchId: batch.id,
          provider: batch.provider,
          error: error instanceof Error ? error.message : String(error),
          submissionAttempts: batch.submissionAttempts + 1,
        });

        return false;
      }
    } finally {
      this.releaseBatchForRecovery(batch.id);
    }
  }

  private claimBatchForRecovery(batchId: string): boolean {
    if (OrphanRecovery.inFlightRecoveryBatchIds.has(batchId)) {
      return false;
    }
    OrphanRecovery.inFlightRecoveryBatchIds.add(batchId);
    return true;
  }

  private releaseBatchForRecovery(batchId: string): void {
    OrphanRecovery.inFlightRecoveryBatchIds.delete(batchId);
  }

  /**
   * Build NorushRequest payloads from the requests stored for a batch.
   */
  private async buildNorushRequests(batchId: string): Promise<NorushRequest[]> {
    const requests = await this.store.getRequestsByBatchId(batchId);
    return requests.map((r) => ({
      id: r.id,
      externalId: r.externalId ?? r.id,
      provider: r.provider,
      model: r.model,
      params: r.params,
    }));
  }

  /**
   * Mark an orphaned batch as permanently failed and fail its requests.
   */
  private async markOrphanFailed(batch: Batch): Promise<void> {
    await this.store.updateBatch(batch.id, { status: 'failed', endedAt: this.now() });

    // Also fail the associated requests.
    const requests = await this.store.getRequestsByBatchId(batch.id);
    for (const req of requests) {
      await this.store.updateRequest(req.id, { status: 'failed' });
    }

    this.telemetry.event('orphan_failed', {
      batchId: batch.id,
      provider: batch.provider,
      submissionAttempts: batch.submissionAttempts,
      maxSubmissionAttempts: batch.maxSubmissionAttempts,
    });
  }

  /**
   * Resolve provider adapter by "provider::apiKeyId" falling back to "provider".
   */
  private resolveAdapter(provider: ProviderName, apiKeyId: string): Provider | undefined {
    return this.providers.get(`${provider}::${apiKeyId}`) ?? this.providers.get(provider);
  }
}
