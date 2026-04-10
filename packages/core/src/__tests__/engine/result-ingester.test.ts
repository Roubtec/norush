import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { ResultIngester } from "../../engine/result-ingester.js";
import { checkRateLimit } from "../../rate-limit/limiter.js";
import { batchCost } from "../../pricing.js";
import type { Provider } from "../../interfaces/provider.js";
import type {
  Batch,
  BatchStatus,
  NewRequest,
  NorushResult,
  ProviderBatchRef,
  SlidingWindow,
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

      // Even the duplicate's request status should be updated idempotently.
      const req = await store.getRequest(requestIds[0]);
      expect(req?.status).toBe("succeeded");
    });

    it("recomputes batch counters from request statuses (idempotent on restart)", async () => {
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 3,
      });

      // Simulate a previous partial run: first result already persisted and
      // request already updated to 'succeeded'.
      await store.createResult({
        requestId: requestIds[0],
        batchId: batch.id,
        response: { content: "Hello" },
      });
      await store.updateRequest(requestIds[0], { status: "succeeded" });

      // Ingester streams all 3 results; requestIds[0] triggers a duplicate.
      const norushResults: NorushResult[] = requestIds.map((id) => ({
        requestId: id,
        response: { content: "Hello" },
        success: true,
      }));

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

      await ingester.ingest(batch);

      // Batch counters should reflect all 3 requests, not just the 2 newly ingested.
      const updatedBatch = await store.getBatch(batch.id);
      expect(updatedBatch?.succeededCount).toBe(3);
      expect(updatedBatch?.failedCount).toBe(0);
    });

    it("updates usage counters on the duplicate path to guard against crash between createResult and counter update", async () => {
      await store.upsertUserLimits("user_01", {
        maxTokensPerPeriod: 1_000_000,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello" },
          success: true,
          inputTokens: 100,
          outputTokens: 200,
        },
      ];

      // Simulate restart after crash: createResult throws duplicate because the
      // result was already persisted in the prior run, but the counter update
      // never completed before the process died.
      vi.spyOn(store, "createResult").mockRejectedValue(
        new Error("duplicate key: unique constraint violation"),
      );

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await ingester.ingest(batch);

      // The result is a duplicate — not re-ingested.
      expect(result.duplicates).toBe(1);
      expect(result.ingested).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Counters must still be updated even on the duplicate path so that
      // a crash between createResult() and the counter update on the previous
      // run does not permanently undercount usage.
      const limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");
      expect(limits.currentPeriodTokens).toBe(300); // 100 + 200
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

  // -----------------------------------------------------------------------
  // Token and spend counter wiring
  // -----------------------------------------------------------------------

  describe("token and spend counter wiring", () => {
    it("increments currentPeriodTokens by inputTokens + outputTokens after ingestion", async () => {
      // Set up user limits so counters exist.
      await store.upsertUserLimits("user_01", {
        maxTokensPerPeriod: 1_000_000,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 2,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello" },
          success: true,
          inputTokens: 100,
          outputTokens: 200,
        },
        {
          requestId: requestIds[1],
          response: { content: "World" },
          success: true,
          inputTokens: 150,
          outputTokens: 250,
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

      const limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");
      // Total tokens: (100+200) + (150+250) = 700
      expect(limits.currentPeriodTokens).toBe(700);
    });

    it("increments currentSpendUsd using batch cost rates after ingestion", async () => {
      await store.upsertUserLimits("user_01", {
        hardSpendLimitUsd: 100.0,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello" },
          success: true,
          inputTokens: 1000,
          outputTokens: 500,
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

      const limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");

      // Expected cost using batch rates for claude provider.
      const expectedCost = batchCost("claude", 1000, 500);
      expect(expectedCost).toBeGreaterThan(0);
      expect(limits.currentSpendUsd).toBeCloseTo(expectedCost, 10);
    });

    it("does not increment counters when token counts are null", async () => {
      await store.upsertUserLimits("user_01", {
        maxTokensPerPeriod: 1_000_000,
        hardSpendLimitUsd: 100.0,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello" },
          success: true,
          // No token counts — inputTokens and outputTokens default to null.
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

      const limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");
      expect(limits.currentPeriodTokens).toBe(0);
      expect(limits.currentSpendUsd).toBe(0);
    });

    it("increments counters for failed results that report tokens", async () => {
      await store.upsertUserLimits("user_01", {
        maxTokensPerPeriod: 1_000_000,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      // Some providers report token usage even for failed results.
      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { error: "content_filter" },
          success: false,
          inputTokens: 50,
          outputTokens: 10,
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

      const limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");
      expect(limits.currentPeriodTokens).toBe(60);
    });

    it("counter increment failure does not block result delivery", async () => {
      await store.upsertUserLimits("user_01", {
        maxTokensPerPeriod: 1_000_000,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello" },
          success: true,
          inputTokens: 100,
          outputTokens: 200,
        },
      ];

      // Make incrementPeriodTokens throw to simulate a store failure.
      vi.spyOn(store, "incrementPeriodTokens").mockRejectedValue(
        new Error("db connection lost"),
      );

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
        telemetry,
      });

      const result = await ingester.ingest(batch);

      // Result should still be ingested successfully despite counter failure.
      expect(result.ingested).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.errors).toHaveLength(0);

      // The error should be logged via telemetry.
      expect(telemetry.event).toHaveBeenCalledWith(
        "usage_counter_error",
        expect.objectContaining({
          requestId: requestIds[0],
          error: "db connection lost",
        }),
      );
    });

    it("accumulates counters across multiple results from different batches", async () => {
      await store.upsertUserLimits("user_01", {
        maxTokensPerPeriod: 1_000_000,
        hardSpendLimitUsd: 100.0,
      });

      // First batch.
      const { batch: batch1, requestIds: reqIds1 } = await createEndedBatch(
        store,
        { requestCount: 1 },
      );
      const results1: NorushResult[] = [
        {
          requestId: reqIds1[0],
          response: { content: "First" },
          success: true,
          inputTokens: 100,
          outputTokens: 200,
        },
      ];

      const provider1 = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(results1)),
      });
      const ingester1 = new ResultIngester({
        store,
        providers: new Map([["claude", provider1]]),
      });
      await ingester1.ingest(batch1);

      // Second batch.
      const { batch: batch2, requestIds: reqIds2 } = await createEndedBatch(
        store,
        { requestCount: 1 },
      );
      const results2: NorushResult[] = [
        {
          requestId: reqIds2[0],
          response: { content: "Second" },
          success: true,
          inputTokens: 300,
          outputTokens: 400,
        },
      ];

      const provider2 = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(results2)),
      });
      const ingester2 = new ResultIngester({
        store,
        providers: new Map([["claude", provider2]]),
      });
      await ingester2.ingest(batch2);

      const limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");
      // Total tokens: (100+200) + (300+400) = 1000
      expect(limits.currentPeriodTokens).toBe(1000);

      // Total spend: batchCost(claude, 100, 200) + batchCost(claude, 300, 400)
      const expectedSpend =
        batchCost("claude", 100, 200) + batchCost("claude", 300, 400);
      expect(limits.currentSpendUsd).toBeCloseTo(expectedSpend, 10);
    });

    it("does not increment when user has no limits configured", async () => {
      // No upsertUserLimits call — user has no limits row.
      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello" },
          success: true,
          inputTokens: 100,
          outputTokens: 200,
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

      // Should succeed without errors — incrementPeriodTokens/incrementSpend
      // silently no-op when user has no limits row.
      expect(result.ingested).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("uses correct provider rates for openai vs claude", async () => {
      await store.upsertUserLimits("user_01", {
        hardSpendLimitUsd: 100.0,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
        provider: "openai",
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Hello from OpenAI" },
          success: true,
          inputTokens: 1000,
          outputTokens: 500,
        },
      ];

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["openai", provider]]),
      });

      await ingester.ingest(batch);

      const limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");

      const expectedCost = batchCost("openai", 1000, 500);
      expect(expectedCost).toBeGreaterThan(0);
      expect(limits.currentSpendUsd).toBeCloseTo(expectedCost, 10);

      // OpenAI and Claude have different rates — verify they differ.
      const claudeCost = batchCost("claude", 1000, 500);
      expect(expectedCost).not.toBeCloseTo(claudeCost, 10);
    });
  });

  // -----------------------------------------------------------------------
  // Token/spend limits trigger after ingestion (end-to-end)
  // -----------------------------------------------------------------------

  describe("rate limit enforcement after ingestion", () => {
    const HEALTHY_WINDOW: SlidingWindow = {
      total: 10,
      succeeded: 10,
      failed: 0,
    };

    it("token limit triggers after ingesting results that exhaust the budget", async () => {
      // Set a token limit of 500 tokens.
      await store.upsertUserLimits("user_01", {
        maxTokensPerPeriod: 500,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Big response" },
          success: true,
          inputTokens: 200,
          outputTokens: 350,
        },
      ];

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      // Before ingestion: rate limit should allow.
      let limits = await store.getUserLimits("user_01");
      let rateLimitResult = checkRateLimit(limits, HEALTHY_WINDOW);
      expect(rateLimitResult.allowed).toBe(true);

      // Ingest the results (550 tokens > 500 limit).
      await ingester.ingest(batch);

      // After ingestion: rate limit should reject.
      limits = await store.getUserLimits("user_01");
      rateLimitResult = checkRateLimit(limits, HEALTHY_WINDOW);
      expect(rateLimitResult.allowed).toBe(false);
      expect(rateLimitResult.reason).toBe("token_limit_exceeded");
    });

    it("spend limit triggers after ingesting results that exhaust the budget", async () => {
      // Compute how many tokens are needed to reach the spend limit.
      // Use a very low spend limit that a single result can exhaust.
      const spendLimit = 0.001; // $0.001
      await store.upsertUserLimits("user_01", {
        hardSpendLimitUsd: spendLimit,
      });

      const { batch, requestIds } = await createEndedBatch(store, {
        requestCount: 1,
      });

      // Use enough tokens to exceed the tiny spend limit.
      const norushResults: NorushResult[] = [
        {
          requestId: requestIds[0],
          response: { content: "Expensive response" },
          success: true,
          inputTokens: 10_000,
          outputTokens: 10_000,
        },
      ];

      const provider = mockProvider({
        fetchResults: vi.fn().mockReturnValue(makeResultStream(norushResults)),
      });

      const ingester = new ResultIngester({
        store,
        providers: new Map([["claude", provider]]),
      });

      // Before ingestion: rate limit should allow.
      let limits = await store.getUserLimits("user_01");
      let rateLimitResult = checkRateLimit(limits, HEALTHY_WINDOW);
      expect(rateLimitResult.allowed).toBe(true);

      await ingester.ingest(batch);

      // After ingestion: spend should exceed limit.
      limits = await store.getUserLimits("user_01");
      if (!limits) throw new Error("expected user limits to exist");
      expect(limits.currentSpendUsd).toBeGreaterThanOrEqual(spendLimit);

      rateLimitResult = checkRateLimit(limits, HEALTHY_WINDOW);
      expect(rateLimitResult.allowed).toBe(false);
      expect(rateLimitResult.reason).toBe("hard_spend_limit_exceeded");
    });
  });
});
