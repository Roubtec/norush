import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { Repackager } from "../../engine/repackager.js";
import type { Batch, NewRequest, RequestStatus } from "../../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNewRequest(overrides: Partial<NewRequest> = {}): NewRequest {
  return {
    provider: "claude",
    model: "claude-sonnet-4-5-20250929",
    params: {
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    },
    userId: "user_01",
    maxRetries: 3,
    ...overrides,
  };
}

/**
 * Create a batch with requests in various statuses.
 */
async function createBatchWithRequests(
  store: MemoryStore,
  requestStatuses: Array<{
    status: RequestStatus;
    retryCount?: number;
    maxRetries?: number;
  }>,
): Promise<Batch> {
  const batch = await store.createBatch({
    provider: "claude",
    apiKeyId: "user_01",
    requestCount: requestStatuses.length,
    maxProviderRetries: 3,
  });

  await store.updateBatch(batch.id, {
    status: "ended",
    providerBatchId: "pb_001",
    submittedAt: new Date(),
    endedAt: new Date(),
  });

  for (const { status, retryCount = 0, maxRetries = 3 } of requestStatuses) {
    const req = await store.createRequest(
      makeNewRequest({ maxRetries }),
    );
    await store.updateRequest(req.id, {
      batchId: batch.id,
      status,
      retryCount,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return (await store.getBatch(batch.id))!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Repackager", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Basic repackaging
  // -----------------------------------------------------------------------

  describe("basic repackaging", () => {
    it("re-queues failed requests with retryCount < maxRetries", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 0, maxRetries: 3 },
        { status: "succeeded" },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.requeued).toBe(1);
      expect(result.exhausted).toBe(0);
      expect(result.scanned).toBe(1);

      // Check that the failed request was re-queued.
      const requests = await store.getRequestsByBatchId(batch.id);
      const failedReq = requests.find((r) => r.retryCount === 1);
      // Re-queued requests have batchId cleared.
      expect(failedReq).toBeUndefined();

      // Re-queued requests should be in the queued pool.
      const queued = await store.getQueuedRequests(100);
      expect(queued).toHaveLength(1);
      expect(queued[0].retryCount).toBe(1);
      expect(queued[0].status).toBe("queued");
      expect(queued[0].batchId).toBeNull();
    });

    it("re-queues expired requests with retryCount < maxRetries", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "expired", retryCount: 0, maxRetries: 3 },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.requeued).toBe(1);
      expect(result.exhausted).toBe(0);

      const queued = await store.getQueuedRequests(100);
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe("queued");
    });

    it("transitions requests exceeding retry budget to failed_final", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 3, maxRetries: 3 },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.requeued).toBe(0);
      expect(result.exhausted).toBe(1);

      const requests = await store.getRequestsByBatchId(batch.id);
      const exhaustedReq = requests.find((r) => r.status === "failed_final");
      expect(exhaustedReq).toBeDefined();
    });

    it("handles mixed results: some re-queued, some exhausted", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 0, maxRetries: 3 },  // re-queue
        { status: "failed", retryCount: 3, maxRetries: 3 },  // exhaust
        { status: "expired", retryCount: 1, maxRetries: 3 }, // re-queue
        { status: "expired", retryCount: 3, maxRetries: 3 }, // exhaust
        { status: "succeeded" },                              // skip
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(4);
      expect(result.requeued).toBe(2);
      expect(result.exhausted).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Status filtering
  // -----------------------------------------------------------------------

  describe("status filtering", () => {
    it("skips succeeded requests", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "succeeded" },
        { status: "succeeded" },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(0);
      expect(result.requeued).toBe(0);
      expect(result.exhausted).toBe(0);
    });

    it("skips canceled requests", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "canceled" },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(0);
    });

    it("skips queued requests", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "queued" },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(0);
    });

    it("skips batched requests", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "batched" },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(0);
    });

    it("skips failed_final requests", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed_final" },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Retry count management
  // -----------------------------------------------------------------------

  describe("retry count management", () => {
    it("increments retryCount on re-queue", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 0, maxRetries: 5 },
      ]);

      const repackager = new Repackager({ store });
      await repackager.repackage(batch);

      const queued = await store.getQueuedRequests(100);
      expect(queued[0].retryCount).toBe(1);
    });

    it("increments retryCount correctly for partially retried requests", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 2, maxRetries: 5 },
      ]);

      const repackager = new Repackager({ store });
      await repackager.repackage(batch);

      const queued = await store.getQueuedRequests(100);
      expect(queued[0].retryCount).toBe(3);
    });

    it("clears batchId when re-queuing", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 0, maxRetries: 3 },
      ]);

      const repackager = new Repackager({ store });
      await repackager.repackage(batch);

      const queued = await store.getQueuedRequests(100);
      expect(queued[0].batchId).toBeNull();
    });

    it("does not re-queue when retryCount equals maxRetries", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 5, maxRetries: 5 },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.requeued).toBe(0);
      expect(result.exhausted).toBe(1);
    });

    it("handles maxRetries of 0 (no retries allowed)", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 0, maxRetries: 0 },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.requeued).toBe(0);
      expect(result.exhausted).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Empty batch
  // -----------------------------------------------------------------------

  describe("empty batch", () => {
    it("handles batch with no requests", async () => {
      const batch = await createBatchWithRequests(store, []);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(0);
      expect(result.requeued).toBe(0);
      expect(result.exhausted).toBe(0);
    });

    it("handles batch with all succeeded requests", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "succeeded" },
        { status: "succeeded" },
        { status: "succeeded" },
      ]);

      const repackager = new Repackager({ store });
      const result = await repackager.repackage(batch);

      expect(result.scanned).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Telemetry
  // -----------------------------------------------------------------------

  describe("telemetry", () => {
    it("emits requests_requeued and requests_exhausted counters", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 0, maxRetries: 3 },
        { status: "failed", retryCount: 3, maxRetries: 3 },
      ]);

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const repackager = new Repackager({ store, telemetry });
      await repackager.repackage(batch);

      expect(telemetry.counter).toHaveBeenCalledWith(
        "requests_requeued",
        1,
        expect.objectContaining({ batchId: batch.id }),
      );
      expect(telemetry.counter).toHaveBeenCalledWith(
        "requests_exhausted",
        1,
        expect.objectContaining({ batchId: batch.id }),
      );
    });

    it("emits repackage_complete event", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "failed", retryCount: 0, maxRetries: 3 },
      ]);

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const repackager = new Repackager({ store, telemetry });
      await repackager.repackage(batch);

      expect(telemetry.event).toHaveBeenCalledWith(
        "repackage_complete",
        expect.objectContaining({
          batchId: batch.id,
          scanned: 1,
          requeued: 1,
          exhausted: 0,
        }),
      );
    });

    it("does not emit counters when nothing to repackage", async () => {
      const batch = await createBatchWithRequests(store, [
        { status: "succeeded" },
      ]);

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const repackager = new Repackager({ store, telemetry });
      await repackager.repackage(batch);

      // Counter should not be called since requeued=0 and exhausted=0.
      const counterCalls = telemetry.counter.mock.calls;
      expect(counterCalls).toHaveLength(0);
    });
  });
});
