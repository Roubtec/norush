/**
 * In-memory Store implementation.
 *
 * Suitable for unit tests and ephemeral scripts. **Not crash-safe** — if the
 * process exits, all in-flight state is lost. For any workload where losing
 * requests matters, use `PostgresStore`.
 */

import { ulid } from "ulidx";
import type { Store, ResultDeliveryUpdate } from "../interfaces/store.js";
import type {
  Batch,
  CostBreakdownEntry,
  DateRange,
  DetailedUsageStats,
  EventLogEntry,
  NewBatch,
  NewEvent,
  NewRequest,
  NewResult,
  Request,
  Result,
  SlidingWindow,
  UsageStats,
  UserLimits,
  UserLimitsInput,
} from "../types.js";
import { standardCost, batchCost } from "../pricing.js";
import { nextPeriodReset } from "../rate-limit/limiter.js";

export class MemoryStore implements Store {
  private requests = new Map<string, Request>();
  private batches = new Map<string, Batch>();
  private results = new Map<string, Result>();
  private events: EventLogEntry[] = [];
  private userLimits = new Map<string, UserLimits>();

  // -- Request lifecycle ----------------------------------------------------

  async createRequest(req: NewRequest): Promise<Request> {
    const now = new Date();
    const record: Request = {
      id: ulid(),
      externalId: null,
      provider: req.provider,
      model: req.model,
      params: structuredClone(req.params),
      status: "queued",
      batchId: null,
      userId: req.userId,
      callbackUrl: req.callbackUrl ?? null,
      webhookSecret: req.webhookSecret ?? null,
      retryCount: 0,
      maxRetries: req.maxRetries ?? 5,
      contentScrubbedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(record.id, record);
    return structuredClone(record);
  }

  async getRequest(id: string): Promise<Request | null> {
    const r = this.requests.get(id);
    return r ? structuredClone(r) : null;
  }

  async updateRequest(id: string, updates: Partial<Request>): Promise<void> {
    const existing = this.requests.get(id);
    if (!existing) throw new Error(`Request not found: ${id}`);
    const { createdAt: _createdAt, ...mutableUpdates } = updates;
    const updated = {
      ...existing,
      ...mutableUpdates,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    };
    // Preserve the original id — callers should not change it.
    updated.id = existing.id;
    this.requests.set(id, updated);
  }

  async getQueuedRequests(limit: number): Promise<Request[]> {
    const queued: Request[] = [];
    for (const r of this.requests.values()) {
      if (r.status === "queued") queued.push(structuredClone(r));
    }
    // Sort by creation time (ULID is already chronological, but use createdAt
    // for clarity since MemoryStore doesn't depend on ULID ordering).
    queued.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return queued.slice(0, limit);
  }

  async assignBatchToRequests(
    ids: string[],
    batchId: string,
    status: "batched",
  ): Promise<void> {
    await Promise.all(
      ids.map((id) => this.updateRequest(id, { batchId, status })),
    );
  }

  // -- API key lookup -------------------------------------------------------

  // MemoryStore does not persist API keys, so this always returns null.
  // BatchManager falls back to userId in that case.
  async findApiKeyId(_userId: string, _provider: string): Promise<string | null> {
    return null;
  }

  // -- Batch lifecycle ------------------------------------------------------

  async createBatch(batch: NewBatch): Promise<Batch> {
    const now = new Date();
    const record: Batch = {
      id: ulid(),
      provider: batch.provider,
      providerBatchId: null,
      apiKeyId: batch.apiKeyId,
      apiKeyLabel: batch.apiKeyLabel ?? null,
      status: "pending",
      requestCount: batch.requestCount,
      succeededCount: 0,
      failedCount: 0,
      submissionAttempts: 0,
      maxSubmissionAttempts: batch.maxSubmissionAttempts ?? 3,
      providerRetries: 0,
      maxProviderRetries: batch.maxProviderRetries ?? 5,
      pollingStrategy: batch.pollingStrategy ?? null,
      submittedAt: null,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.batches.set(record.id, record);
    return structuredClone(record);
  }

  async getBatch(id: string): Promise<Batch | null> {
    const b = this.batches.get(id);
    return b ? structuredClone(b) : null;
  }

  async updateBatch(id: string, updates: Partial<Batch>): Promise<void> {
    const existing = this.batches.get(id);
    if (!existing) throw new Error(`Batch not found: ${id}`);
    const { createdAt: _createdAt, ...mutableUpdates } = updates;
    const updated = { ...existing, ...mutableUpdates, updatedAt: new Date() };
    updated.id = existing.id;
    updated.createdAt = existing.createdAt;
    this.batches.set(id, updated);
  }

  async getPendingBatches(): Promise<Batch[]> {
    const pending: Batch[] = [];
    for (const b of this.batches.values()) {
      if (b.status === "pending") pending.push(structuredClone(b));
    }
    pending.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return pending;
  }

  async getInFlightBatches(): Promise<Batch[]> {
    const inFlight: Batch[] = [];
    for (const b of this.batches.values()) {
      if (b.status === "submitted" || b.status === "processing") {
        inFlight.push(structuredClone(b));
      }
    }
    inFlight.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return inFlight;
  }

  async getRequestsByBatchId(batchId: string): Promise<Request[]> {
    const results: Request[] = [];
    for (const r of this.requests.values()) {
      if (r.batchId === batchId) results.push(structuredClone(r));
    }
    results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return results;
  }

  // -- Result lifecycle -----------------------------------------------------

  async createResult(result: NewResult): Promise<Result> {
    const now = new Date();
    const record: Result = {
      id: ulid(),
      requestId: result.requestId,
      batchId: result.batchId,
      response: structuredClone(result.response),
      stopReason: result.stopReason ?? null,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      deliveryStatus: "pending",
      deliveryAttempts: 0,
      maxDeliveryAttempts: 5,
      lastDeliveryError: null,
      nextDeliveryAt: null,
      deliveredAt: null,
      contentScrubbedAt: null,
      createdAt: now,
    };
    this.results.set(record.id, record);
    return structuredClone(record);
  }

  async updateResult(id: string, updates: ResultDeliveryUpdate): Promise<void> {
    const existing = this.results.get(id);
    if (!existing) throw new Error(`Result not found: ${id}`);
    // Only delivery-tracking fields are mutable — immutable fields (id,
    // requestId, batchId, response, tokens, createdAt) are never touched.
    const updated: Result = {
      ...existing,
      deliveryStatus: updates.deliveryStatus ?? existing.deliveryStatus,
      deliveryAttempts: updates.deliveryAttempts ?? existing.deliveryAttempts,
      maxDeliveryAttempts:
        updates.maxDeliveryAttempts ?? existing.maxDeliveryAttempts,
      lastDeliveryError:
        updates.lastDeliveryError !== undefined
          ? updates.lastDeliveryError
          : existing.lastDeliveryError,
      nextDeliveryAt:
        updates.nextDeliveryAt !== undefined
          ? updates.nextDeliveryAt
          : existing.nextDeliveryAt,
      deliveredAt:
        updates.deliveredAt !== undefined
          ? updates.deliveredAt
          : existing.deliveredAt,
      contentScrubbedAt:
        updates.contentScrubbedAt !== undefined
          ? updates.contentScrubbedAt
          : existing.contentScrubbedAt,
    };
    this.results.set(id, updated);
  }

  async getUndeliveredResults(limit: number): Promise<Result[]> {
    const undelivered: Result[] = [];
    for (const r of this.results.values()) {
      if (r.deliveryStatus === "pending" || r.deliveryStatus === "failed") {
        undelivered.push(structuredClone(r));
      }
    }
    undelivered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return undelivered.slice(0, limit);
  }

  async markDelivered(id: string): Promise<void> {
    const existing = this.results.get(id);
    if (!existing) throw new Error(`Result not found: ${id}`);
    existing.deliveryStatus = "delivered";
    existing.deliveredAt = new Date();
  }

  // -- Event log ------------------------------------------------------------

  async logEvent(event: NewEvent): Promise<EventLogEntry> {
    const entry: EventLogEntry = {
      id: ulid(),
      entityType: event.entityType,
      entityId: event.entityId,
      event: event.event,
      details: event.details ?? null,
      createdAt: new Date(),
    };
    this.events.push(entry);
    return structuredClone(entry);
  }

  /** Get all event log entries (test helper, not part of Store interface). */
  getEvents(): EventLogEntry[] {
    return structuredClone(this.events);
  }

  // -- Retention ------------------------------------------------------------

  async scrubExpiredContent(before: Date): Promise<number> {
    let count = 0;
    const now = new Date();

    for (const r of this.requests.values()) {
      if (
        r.contentScrubbedAt === null &&
        r.createdAt < before &&
        (r.status === "succeeded" || r.status === "failed" || r.status === "failed_final")
      ) {
        r.params = { scrubbed: true };
        r.contentScrubbedAt = now;
        r.updatedAt = now;
        count++;
      }
    }

    for (const r of this.results.values()) {
      if (r.contentScrubbedAt === null && r.createdAt < before) {
        r.response = { scrubbed: true };
        r.contentScrubbedAt = now;
        count++;
      }
    }

    return count;
  }

  // -- Telemetry / analytics ------------------------------------------------

  async getStats(userId: string, period: DateRange): Promise<UsageStats> {
    let totalRequests = 0;
    let succeededRequests = 0;
    let failedRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const batchIds = new Set<string>();

    for (const r of this.requests.values()) {
      if (
        r.userId === userId &&
        r.createdAt >= period.from &&
        r.createdAt <= period.to
      ) {
        totalRequests++;
        if (r.status === "succeeded") succeededRequests++;
        if (r.status === "failed" || r.status === "failed_final")
          failedRequests++;
        if (r.batchId) batchIds.add(r.batchId);
      }
    }

    for (const res of this.results.values()) {
      // Match results to the user's requests within the period.
      const req = this.requests.get(res.requestId);
      if (
        req &&
        req.userId === userId &&
        req.createdAt >= period.from &&
        req.createdAt <= period.to
      ) {
        if (res.inputTokens != null) totalInputTokens += res.inputTokens;
        if (res.outputTokens != null) totalOutputTokens += res.outputTokens;
      }
    }

    return {
      totalRequests,
      succeededRequests,
      failedRequests,
      totalInputTokens,
      totalOutputTokens,
      totalBatches: batchIds.size,
    };
  }

  async getDetailedStats(
    userId: string,
    period: DateRange,
  ): Promise<DetailedUsageStats> {
    const basic = await this.getStats(userId, period);

    // Group by provider + model for cost breakdown.
    const groupKey = (provider: string, model: string) =>
      `${provider}::${model}`;
    const groups = new Map<
      string,
      {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        requestCount: number;
      }
    >();

    for (const r of this.requests.values()) {
      if (
        r.userId === userId &&
        r.createdAt >= period.from &&
        r.createdAt <= period.to
      ) {
        const key = groupKey(r.provider, r.model);
        if (!groups.has(key)) {
          groups.set(key, {
            provider: r.provider,
            model: r.model,
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 0,
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- key was just set above
        const g = groups.get(key)!;
        g.requestCount++;

        // Sum tokens from the matching result.
        for (const res of this.results.values()) {
          if (res.requestId === r.id) {
            if (res.inputTokens) g.inputTokens += res.inputTokens;
            if (res.outputTokens) g.outputTokens += res.outputTokens;
          }
        }
      }
    }

    const costBreakdown: CostBreakdownEntry[] = [...groups.values()].map(
      (g) => ({
        provider: g.provider as CostBreakdownEntry["provider"],
        model: g.model,
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        batchCostUsd: batchCost(g.provider, g.inputTokens, g.outputTokens),
        standardCostUsd: standardCost(
          g.provider,
          g.inputTokens,
          g.outputTokens,
        ),
        requestCount: g.requestCount,
      }),
    );

    // Calculate batch turnaround times.
    const turnarounds: number[] = [];
    for (const b of this.batches.values()) {
      if (!b.submittedAt || !b.endedAt) continue;
      // Only count batches that belong to this user's requests in the period.
      const userRequests = [...this.requests.values()].filter(
        (r) =>
          r.batchId === b.id &&
          r.userId === userId &&
          r.createdAt >= period.from &&
          r.createdAt <= period.to,
      );
      if (userRequests.length === 0) continue;
      turnarounds.push(b.endedAt.getTime() - b.submittedAt.getTime());
    }
    const avgTurnaroundMs =
      turnarounds.length > 0
        ? turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length
        : null;

    const totalStandardCostUsd = costBreakdown.reduce(
      (s, e) => s + e.standardCostUsd,
      0,
    );
    const totalBatchCostUsd = costBreakdown.reduce(
      (s, e) => s + e.batchCostUsd,
      0,
    );

    return {
      ...basic,
      costBreakdown,
      avgTurnaroundMs,
      totalBatchCostUsd,
      totalStandardCostUsd,
      totalSavingsUsd: totalStandardCostUsd - totalBatchCostUsd,
    };
  }

  // -- User limits (rate limiting / spend controls) --------------------------

  async getUserLimits(userId: string): Promise<UserLimits | null> {
    const limits = this.userLimits.get(userId);
    return limits ? structuredClone(limits) : null;
  }

  async upsertUserLimits(
    userId: string,
    input: UserLimitsInput,
  ): Promise<UserLimits> {
    const now = new Date();
    const existing = this.userLimits.get(userId);

    if (existing) {
      const updated: UserLimits = {
        ...existing,
        maxRequestsPerHour:
          input.maxRequestsPerHour !== undefined
            ? input.maxRequestsPerHour
            : existing.maxRequestsPerHour,
        maxTokensPerPeriod:
          input.maxTokensPerPeriod !== undefined
            ? input.maxTokensPerPeriod
            : existing.maxTokensPerPeriod,
        hardSpendLimitUsd:
          input.hardSpendLimitUsd !== undefined
            ? input.hardSpendLimitUsd
            : existing.hardSpendLimitUsd,
        updatedAt: now,
      };
      this.userLimits.set(userId, updated);
      return structuredClone(updated);
    }

    const record: UserLimits = {
      userId,
      maxRequestsPerHour: input.maxRequestsPerHour ?? null,
      maxTokensPerPeriod: input.maxTokensPerPeriod ?? null,
      hardSpendLimitUsd: input.hardSpendLimitUsd ?? null,
      currentPeriodRequests: 0,
      currentPeriodTokens: 0,
      currentSpendUsd: 0,
      periodResetAt: nextPeriodReset(now),
      createdAt: now,
      updatedAt: now,
    };
    this.userLimits.set(userId, record);
    return structuredClone(record);
  }

  async incrementPeriodRequests(
    userId: string,
    count: number = 1,
  ): Promise<void> {
    const limits = this.userLimits.get(userId);
    if (!limits) return;
    limits.currentPeriodRequests += count;
    limits.updatedAt = new Date();
  }

  async incrementPeriodTokens(
    userId: string,
    count: number,
  ): Promise<void> {
    const limits = this.userLimits.get(userId);
    if (!limits) return;
    limits.currentPeriodTokens += count;
    limits.updatedAt = new Date();
  }

  async incrementSpend(userId: string, amountUsd: number): Promise<void> {
    const limits = this.userLimits.get(userId);
    if (!limits) return;
    limits.currentSpendUsd += amountUsd;
    limits.updatedAt = new Date();
  }

  async resetPeriod(userId: string, nextResetAt: Date): Promise<void> {
    const limits = this.userLimits.get(userId);
    if (!limits) return;
    limits.currentPeriodRequests = 0;
    limits.currentPeriodTokens = 0;
    limits.periodResetAt = nextResetAt;
    limits.updatedAt = new Date();
  }

  async getSlidingWindow(
    userId: string,
    windowMs: number,
  ): Promise<SlidingWindow> {
    const windowStart = new Date(Date.now() - windowMs);
    let succeeded = 0;
    let failed = 0;

    for (const batch of this.batches.values()) {
      // Only count batches for this user's requests.
      // In memory store, we check by looking at requests in the batch.
      const requests = [...this.requests.values()].filter(
        (r) => r.batchId === batch.id && r.userId === userId,
      );
      if (requests.length === 0) continue;

      // Only count batches that ended within the window.
      if (!batch.endedAt || batch.endedAt < windowStart) continue;

      if (batch.status === "ended" && batch.failedCount === 0) {
        succeeded++;
      } else if (
        batch.status === "ended" ||
        batch.status === "failed" ||
        batch.status === "expired"
      ) {
        failed++;
      }
    }

    return { total: succeeded + failed, succeeded, failed };
  }
}
