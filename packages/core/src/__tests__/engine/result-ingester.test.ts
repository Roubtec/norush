import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { ResultIngester } from "../../engine/result-ingester.js";
import type { Provider } from "../../interfaces/provider.js";
import type {
  Batch,
  BatchStatus,
  NewRequest,
  NorushResult,
  ProviderBatchRef,
} from "../../types.js";

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
    ...overrides,
  };
}

function mockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    submitBatch: vi.fn().mockResolvedValue({
      providerBatchId: "provider_batch_001",
      provider: "claude",
    } satisfies ProviderBatchRef),
    checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
    fetchResults: vi.fn(),
    cancelBatch: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a completed batch in the store with associated requests.
 */
async function createEndedBatch(
  store: MemoryStore,
  options: {
    requestCount?: number;
    provider?: "claude" | "openai";
    providerBatchId?: string;
  } = {},
): Promise<{ batch: Batch; requestIds: string[] }> {
  const {
    requestCount = 3,
    provider = "claude",
    providerBatchId = "pb_001",
  } = options;

  const batch = await store.createBatch({
    provider,
    apiKeyId: "user_01",
    requestCount,
  });

  await store.updateBatch(batch.id, {
    status: "ended",
    providerBatchId,
    submittedAt: new Date(),
    endedAt: new Date(),
    submissionAttempts: 1,
  });

  const requestIds: string[] = [];
  for (let i = 0; i < requestCount; i++) {
    const req = await store.createRequest(makeNewRequest({ provider }));
    await store.updateRequest(req.id, {
      batchId: batch.id,
      status: "batched",
    });
    requestIds.push(req.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const updatedBatch = (await store.getBatch(batch.id))!;
  return { batch: updatedBatch, requestIds };
}

/**
 * Create an async iterable from an array of NorushResults.
 */
async function* makeResultStream(
  results: NorushResult[],
): AsyncIterable<NorushResult> {
  for (const r of results) {
    yield r;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResultIngester", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Successful ingestion
  // -----------------------------------------------------------------------

  describe("successful ingestion", () => {
    it("ingests all results from a batch and persists them", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 3,
      });

      const norushResults: NorushResult[] = requestIds.map((id) => ({
        requestId: id,
        response: { content: "Hello back!" },
        success: true,
        stopReason: "end_turn",
        inputTokens: 10,
        outputTokens: 20,
      }));

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await ingester.ingest(batch);

      expect(result.ingested).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.duplicates).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("persists each result individually to the store", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 2,
      });

      const norushResults: NorushResult[] = requestIds.map((id) => ({
        requestId: id,
        response: { content: "Response" },
        success: true,
        stopReason: "end_turn",
        inputTokens: 5,
        outputTokens: 15,
      }));

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      await ingester.ingest(batch);

      // Check that results are in the store.
      const undelivered = await store.getUndeliveredResults(100);
      expect(undelivered).toHaveLength(2);

      for (const result of undelivered) {
        expect(result.batchId).toBe(batch.id);
        expect(result.deliveryStatus).toBe("pending");
        expect(result.stopReason).toBe("end_turn");
        expect(result.inputTokens).toBe(5);
        expect(result.outputTokens).toBe(15);
      }
    });

    it("updates request status to succeeded for successful results", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello" },
          success: true,
        },
      ];

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      await ingester.ingest(batch);

      const request = await store.getRequest(requestIds[0]);
      expect(request?.status).toBe("succeeded");
    });

    it("updates request status to failed for failed results", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { error: "rate_limit" },
          success: false,
        },
      ];

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      await ingester.ingest(batch);

      const request = await store.getRequest(requestIds[0]);
      expect(request?.status).toBe("failed");
    });

    it("handles mixed success and failure results", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 3,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "OK" },
          success: true,
        },
        {
          requestId: requestIds[1],
          response: { error: "server_error" },
          success: false,
        },
        {
          requestId: requestIds[2],
          response: { content: "Also OK" },
          success: true,
        },
      ];

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await ingester.ingest(batch);

      expect(result.ingested).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
    });

    it("updates batch succeeded and failed counters", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 3,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "OK" },
          success: true,
        },
        {
          requestId: requestIds[1],
          response: { error: "err" },
          success: false,
        },
        {
          requestId: requestIds[2],
          response: { content: "OK" },
          success: true,
        },
      ];

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      await ingester.ingest(batch);

      const updatedBatch = await store.getBatch(batch.id);
      expect(updatedBatch?.succeededCount).toBe(2);
      expect(updatedBatch?.failedCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Crash recovery / idempotency
  // -----------------------------------------------------------------------

  describe("crash recovery", () => {
    it("partial ingestion: already-persisted results survive", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 3,
      });

      const norushResults: NorushResult[] = requestIds.map((id) => ({
        requestId: id,
        response: { content: "Hello" },
        success: true,
      }));

      // Simulate partial ingestion: manually persist the first result.
      await store.createResult({
        requestId: requestIds[0],
        batchId: batch.id,
        response: { content: "Hello" },
      });
      await store.updateRequest(requestIds[0], { status: "succeeded" });

      // Create provider that streams all results (including the already-persisted one).
      // MemoryStore doesn't enforce uniqueness on requestId, so the duplicate
      // will just create another record. In PostgresStore, it would hit a
      // unique constraint and be caught as a duplicate.
      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await ingester.ingest(batch);

      // All 3 should be ingested (MemoryStore allows duplicates).
      expect(result.ingested).toBe(3);
      expect(result.errors).toHaveLength(0);

      // The store should have 4 results (1 manual + 3 ingested).
      // This is expected with MemoryStore; PostgresStore would have 3 with 1 duplicate.
      const allResults = await store.getUndeliveredResults(100);
      expect(allResults.length).toBe(4);
    });

    it("handles duplicate detection when createResult throws", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 2,
      });

      const norushResults: NorushResult[] = requestIds.map((id) => ({
        requestId: id,
        response: { content: "Hello" },
        success: true,
      }));

      // Mock createResult to throw duplicate error on first call.
      const originalCreateResult = store.createResult.bind(store);
      let callCount = 0;
      vi.spyOn(store, "createResult").mockImplementation(async (res) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("duplicate key: unique constraint violation");
        }
        return originalCreateResult(res);
      });

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await ingester.ingest(batch);

      expect(result.duplicates).toBe(1);
      expect(result.ingested).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("captures non-duplicate errors without stopping ingestion", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 3,
      });

      const norushResults: NorushResult[] = requestIds.map((id) => ({
        requestId: id,
        response: { content: "Hello" },
        success: true,
      }));

      // Mock createResult to throw a non-duplicate error on the second call.
      const originalCreateResult = store.createResult.bind(store);
      let callCount = 0;
      vi.spyOn(store, "createResult").mockImplementation(async (res) => {
        callCount++;
        if (callCount === 2) {
          throw new Error("disk full");
        }
        return originalCreateResult(res);
      });

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await ingester.ingest(batch);

      // First and third results should succeed, second should error.
      expect(result.ingested).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("disk full");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("returns error when batch has no provider batch ID", async () => {
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", mockProvider()]]),
      });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const batchRecord = (await store.getBatch(batch.id))!;
      const result = await ingester.ingest(batchRecord);

      expect(result.ingested).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("no provider batch ID");
    });

    it("returns error when no provider adapter found", async () => {
      const { batch } = await createEndedBatch(store, {
        provider: "openai",
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", mockProvider()]]), // no openai
      });

      const result = await ingester.ingest(batch);

      expect(result.ingested).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("No provider adapter");
    });

    it("handles empty result stream", async () => {
      const { batch } = await createEndedBatch(store, { requestCount: 0 });

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream([])),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await ingester.ingest(batch);

      expect(result.ingested).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("resolves provider by composite key (provider::apiKeyId)", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "OK" },
          success: true,
        },
      ];

      const specificProvider = mockProvider({
        fetchResults: vi
          .fn()
          .mockReturnValue(makeResultStream(norushResults)),
      });
      const genericProvider = mockProvider();

      const ingester = new ResultIngester({
        store,
        providers: new Map([
          ["claude", genericProvider],
          ["claude::user_01", specificProvider],
        ]),
      });

      await ingester.ingest(batch);

      // Should use the specific provider, not the generic one.
      expect(specificProvider.fetchResults).toHaveBeenCalledOnce();
      expect(genericProvider.fetchResults).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Telemetry
  // -----------------------------------------------------------------------

  describe("telemetry", () => {
    it("emits results_ingested counter", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 2,
      });

      const norushResults: NorushResult[] = requestIds.map((id) => ({
        requestId: id,
        response: { content: "Hello" },
        success: true,
      }));

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
        telemetry,
      });

      await ingester.ingest(batch);

      expect(telemetry.counter).toHaveBeenCalledWith(
        "results_ingested",
        2,
        expect.objectContaining({ provider: "claude" }),
      );
    });

    it("emits ingestion_complete event", async () => {
      const { batch } = await createEndedBatch(store, { requestCount: 0 });

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream([])),
      });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
        telemetry,
      });

      await ingester.ingest(batch);

      expect(telemetry.event).toHaveBeenCalledWith(
        "ingestion_complete",
        expect.objectContaining({
          batchId: batch.id,
        }),
      );
    });
  });
});
