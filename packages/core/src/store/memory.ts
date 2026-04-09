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
  DateRange,
  NewBatch,
  NewRequest,
  NewResult,
  Request,
  Result,
  UsageStats,
} from "../types.js";

export class MemoryStore implements Store {
  private requests = new Map<string, Request>();
  private batches = new Map<string, Batch>();
  private results = new Map<string, Result>();

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
}
