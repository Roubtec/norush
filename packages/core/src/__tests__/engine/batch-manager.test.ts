import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { BatchManager, PROVIDER_LIMITS } from "../../engine/batch-manager.js";
import type { BatchingConfig } from "../../config/types.js";
import type { Provider } from "../../interfaces/provider.js";
import type { NewRequest, NorushRequest, ProviderBatchRef } from "../../types.js";

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

function defaultBatching(overrides: Partial<BatchingConfig> = {}): BatchingConfig {
  return {
    maxRequests: 1000,
    maxBytes: 50_000_000,
    flushIntervalMs: 0,
    ...overrides,
  };
}

function mockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    submitBatch: vi.fn().mockResolvedValue({
      providerBatchId: "provider_batch_001",
      provider: "claude",
    } satisfies ProviderBatchRef),
    checkStatus: vi.fn().mockResolvedValue("processing"),
    fetchResults: vi.fn(),
    cancelBatch: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchManager", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // -------------------------------------------------------------------------
  // Basic flush
  // -------------------------------------------------------------------------

  describe("flush", () => {
    it("does nothing when there are no queued requests", async () => {
      const provider = mockProvider();
      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(provider.submitBatch).not.toHaveBeenCalled();
    });

    it("submits a single batch for queued requests", async () => {
      // Create some queued requests.
      await store.createRequest(makeNewRequest());
      await store.createRequest(makeNewRequest());

      const provider = mockProvider();
      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(provider.submitBatch).toHaveBeenCalledOnce();
      const submitted = (provider.submitBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NorushRequest[];
      expect(submitted).toHaveLength(2);
    });

    it("creates a batch record before calling the provider", async () => {
      await store.createRequest(makeNewRequest());

      const callOrder: string[] = [];

      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async () => {
          callOrder.push("provider_called");
          return { providerBatchId: "pb_001", provider: "claude" as const };
        }),
      });

      const originalCreateBatch = store.createBatch.bind(store);
      vi.spyOn(store, "createBatch").mockImplementation(async (...args) => {
        callOrder.push("batch_created");
        return originalCreateBatch(...args);
      });

      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(callOrder).toEqual(["batch_created", "provider_called"]);
    });
  });

  // -------------------------------------------------------------------------
  // Write-before-submit protocol
  // -------------------------------------------------------------------------

  describe("write-before-submit protocol", () => {
    it("creates batch with status 'pending' before submission", async () => {
      const reqRecord = await store.createRequest(makeNewRequest());

      let batchStatusDuringSubmit: string | undefined;

      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async (reqs: NorushRequest[]) => {
          // Check the batch record status during provider call.
          const req = await store.getRequest(reqs[0].id);
          if (req?.batchId) {
            const batch = await store.getBatch(req.batchId);
            batchStatusDuringSubmit = batch?.status;
          }
          return { providerBatchId: "pb_001", provider: "claude" as const };
        }),
      });

      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // During the provider call, the batch should still be 'pending'.
      expect(batchStatusDuringSubmit).toBe("pending");

      // After flush, the batch should be 'submitted'.
      const stored = await store.getRequest(reqRecord.id);
      expect(stored).toBeTruthy();
      expect(stored?.batchId).toBeTruthy();
      const batch = await store.getBatch(stored?.batchId ?? "");
      expect(batch).toBeTruthy();
      expect(batch?.status).toBe("submitted");
      expect(batch?.providerBatchId).toBe("pb_001");
      expect(batch?.submissionAttempts).toBe(1);
      expect(batch?.submittedAt).toBeInstanceOf(Date);
    });

    it("increments submission_attempts before calling provider", async () => {
      await store.createRequest(makeNewRequest());

      let submissionAttemptsDuringCall: number | undefined;

      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async (reqs: NorushRequest[]) => {
          const req = await store.getRequest(reqs[0].id);
          if (req?.batchId) {
            const batch = await store.getBatch(req.batchId);
            submissionAttemptsDuringCall = batch?.submissionAttempts;
          }
          return { providerBatchId: "pb_002", provider: "claude" as const };
        }),
      });

      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(submissionAttemptsDuringCall).toBe(1);
    });

    it("on submission failure: batch remains pending with NULL provider_batch_id", async () => {
      const reqRecord = await store.createRequest(makeNewRequest());

      const provider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error("API error")),
      });

      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // Batch should exist but remain pending.
      const stored = await store.getRequest(reqRecord.id);
      expect(stored).toBeTruthy();
      expect(stored?.batchId).toBeTruthy();
      const batch = await store.getBatch(stored?.batchId ?? "");
      expect(batch).toBeTruthy();
      expect(batch?.status).toBe("pending");
      expect(batch?.providerBatchId).toBeNull();
      expect(batch?.submissionAttempts).toBe(1);
    });

    it("updates requests to 'batched' status with batch_id", async () => {
      const r1 = await store.createRequest(makeNewRequest());
      const r2 = await store.createRequest(makeNewRequest());

      const provider = mockProvider();
      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      const stored1 = await store.getRequest(r1.id);
      const stored2 = await store.getRequest(r2.id);
      expect(stored1).toBeTruthy();
      expect(stored2).toBeTruthy();
      expect(stored1?.status).toBe("batched");
      expect(stored2?.status).toBe("batched");
      expect(stored1?.batchId).toBeTruthy();
      expect(stored1?.batchId).toBe(stored2?.batchId);
    });
  });

  // -------------------------------------------------------------------------
  // Grouping logic
  // -------------------------------------------------------------------------

  describe("request grouping", () => {
    it("groups requests by (provider, model, userId)", async () => {
      // Two requests for same group.
      await store.createRequest(makeNewRequest({ provider: "claude", model: "claude-sonnet-4-5-20250929", userId: "user_01" }));
      await store.createRequest(makeNewRequest({ provider: "claude", model: "claude-sonnet-4-5-20250929", userId: "user_01" }));
      // One request for a different model.
      await store.createRequest(makeNewRequest({ provider: "claude", model: "claude-opus-4-6", userId: "user_01" }));

      const claudeProvider = mockProvider();
      const providers = new Map([["claude", claudeProvider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // Should create 2 batches: one for sonnet (2 reqs), one for opus (1 req).
      expect(claudeProvider.submitBatch).toHaveBeenCalledTimes(2);

      const calls = (claudeProvider.submitBatch as ReturnType<typeof vi.fn>).mock.calls;
      const sizes = calls.map((c: unknown[]) => (c[0] as NorushRequest[]).length).sort();
      expect(sizes).toEqual([1, 2]);
    });

    it("creates separate batches for different users (key isolation)", async () => {
      await store.createRequest(makeNewRequest({ userId: "user_A" }));
      await store.createRequest(makeNewRequest({ userId: "user_B" }));

      const provider = mockProvider();
      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      // Two separate batches: one per user.
      expect(provider.submitBatch).toHaveBeenCalledTimes(2);
    });

    it("creates separate batches for different providers", async () => {
      await store.createRequest(makeNewRequest({ provider: "claude", userId: "user_01" }));
      await store.createRequest(makeNewRequest({ provider: "openai", model: "gpt-4o", userId: "user_01" }));

      const claudeProvider = mockProvider();
      const openaiProvider = mockProvider({
        submitBatch: vi.fn().mockResolvedValue({
          providerBatchId: "oai_batch_001",
          provider: "openai",
        }),
      });

      const providers = new Map([
        ["claude", claudeProvider],
        ["openai", openaiProvider],
      ]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(claudeProvider.submitBatch).toHaveBeenCalledOnce();
      expect(openaiProvider.submitBatch).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Size-based splitting
  // -------------------------------------------------------------------------

  describe("size-based splitting", () => {
    it("splits batches that exceed provider max request count", async () => {
      // Temporarily lower the provider limit for testing.
      const originalLimit = PROVIDER_LIMITS.claude.maxRequests;
      PROVIDER_LIMITS.claude.maxRequests = 3;

      try {
        // Create 5 requests (should split into 2 batches: 3 + 2).
        for (let i = 0; i < 5; i++) {
          await store.createRequest(makeNewRequest());
        }

        const provider = mockProvider();
        const providers = new Map([["claude", provider]]);
        const manager = new BatchManager({
          store,
          providers,
          batching: defaultBatching({ maxRequests: 100 }),
        });

        await manager.flush();

        expect(provider.submitBatch).toHaveBeenCalledTimes(2);

        const calls = (provider.submitBatch as ReturnType<typeof vi.fn>).mock.calls;
        const firstBatch = calls[0][0] as NorushRequest[];
        const secondBatch = calls[1][0] as NorushRequest[];
        expect(firstBatch).toHaveLength(3);
        expect(secondBatch).toHaveLength(2);
      } finally {
        PROVIDER_LIMITS.claude.maxRequests = originalLimit;
      }
    });

    it("splits batches that exceed provider max byte size", async () => {
      const originalLimit = PROVIDER_LIMITS.claude.maxBytes;

      // Create requests with known param sizes.
      const largeContent = "x".repeat(500);
      const req = makeNewRequest({
        params: { messages: [{ role: "user", content: largeContent }] },
      });
      const reqBytes = new TextEncoder().encode(
        JSON.stringify(req.params),
      ).byteLength;

      // Set limit so that only 2 requests fit per batch.
      PROVIDER_LIMITS.claude.maxBytes = reqBytes * 2 + 1;

      try {
        await store.createRequest(makeNewRequest({ params: req.params }));
        await store.createRequest(makeNewRequest({ params: req.params }));
        await store.createRequest(makeNewRequest({ params: req.params }));

        const provider = mockProvider();
        const providers = new Map([["claude", provider]]);
        const manager = new BatchManager({
          store,
          providers,
          batching: defaultBatching({ maxRequests: 100 }),
        });

        await manager.flush();

        // Should split: 2 + 1.
        expect(provider.submitBatch).toHaveBeenCalledTimes(2);

        const calls = (provider.submitBatch as ReturnType<typeof vi.fn>).mock.calls;
        const firstBatch = calls[0][0] as NorushRequest[];
        const secondBatch = calls[1][0] as NorushRequest[];
        expect(firstBatch).toHaveLength(2);
        expect(secondBatch).toHaveLength(1);
      } finally {
        PROVIDER_LIMITS.claude.maxBytes = originalLimit;
      }
    });

    it("respects different limits per provider", () => {
      expect(PROVIDER_LIMITS.claude.maxRequests).toBe(100_000);
      expect(PROVIDER_LIMITS.claude.maxBytes).toBe(256 * 1024 * 1024);
      expect(PROVIDER_LIMITS.openai.maxRequests).toBe(50_000);
      expect(PROVIDER_LIMITS.openai.maxBytes).toBe(200 * 1024 * 1024);
    });
  });

  // -------------------------------------------------------------------------
  // Provider adapter resolution
  // -------------------------------------------------------------------------

  describe("provider adapter resolution", () => {
    it("resolves adapter by 'provider::userId' key first", async () => {
      await store.createRequest(makeNewRequest({ provider: "claude", userId: "user_01" }));

      const specificProvider = mockProvider();
      const fallbackProvider = mockProvider();

      const providers = new Map([
        ["claude::user_01", specificProvider],
        ["claude", fallbackProvider],
      ]);

      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(specificProvider.submitBatch).toHaveBeenCalledOnce();
      expect(fallbackProvider.submitBatch).not.toHaveBeenCalled();
    });

    it("falls back to provider-only key when specific key not found", async () => {
      await store.createRequest(makeNewRequest({ provider: "claude", userId: "user_99" }));

      const fallbackProvider = mockProvider();
      const providers = new Map([["claude", fallbackProvider]]);

      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      expect(fallbackProvider.submitBatch).toHaveBeenCalledOnce();
    });

    it("skips batch when no adapter is found", async () => {
      await store.createRequest(makeNewRequest({ provider: "openai", model: "gpt-4o" }));

      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      // No openai provider registered.
      const providers = new Map([["claude", mockProvider()]]);

      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
      });

      await manager.flush();

      expect(telemetry.event).toHaveBeenCalledWith(
        "batch_submit_error",
        expect.objectContaining({
          error: expect.stringContaining("No provider adapter found"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // NorushRequest mapping
  // -------------------------------------------------------------------------

  describe("NorushRequest mapping", () => {
    it("maps Request records to NorushRequest payloads for the provider", async () => {
      const reqRecord = await store.createRequest(
        makeNewRequest({
          params: { max_tokens: 2048, messages: [{ role: "user", content: "test" }] },
        }),
      );

      const provider = mockProvider();
      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      const submitted = (provider.submitBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NorushRequest[];
      expect(submitted).toHaveLength(1);
      expect(submitted[0].id).toBe(reqRecord.id);
      expect(submitted[0].provider).toBe("claude");
      expect(submitted[0].model).toBe("claude-sonnet-4-5-20250929");
      expect(submitted[0].params).toEqual({
        max_tokens: 2048,
        messages: [{ role: "user", content: "test" }],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  describe("telemetry", () => {
    it("emits batches_submitted counter on success", async () => {
      await store.createRequest(makeNewRequest());

      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const provider = mockProvider();
      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
      });

      await manager.flush();

      expect(telemetry.counter).toHaveBeenCalledWith("batches_submitted", 1, {
        provider: "claude",
        status: "success",
      });

      expect(telemetry.event).toHaveBeenCalledWith(
        "batch_submitted",
        expect.objectContaining({
          provider: "claude",
          providerBatchId: "provider_batch_001",
        }),
      );
    });

    it("emits batches_submitted counter with failure status on error", async () => {
      await store.createRequest(makeNewRequest());

      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const provider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error("Network timeout")),
      });

      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
        telemetry,
      });

      await manager.flush();

      expect(telemetry.counter).toHaveBeenCalledWith("batches_submitted", 1, {
        provider: "claude",
        status: "failure",
      });

      expect(telemetry.event).toHaveBeenCalledWith(
        "batch_submit_error",
        expect.objectContaining({
          error: "Network timeout",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Batch record accuracy
  // -------------------------------------------------------------------------

  describe("batch record accuracy", () => {
    it("batch requestCount matches the number of requests in the batch", async () => {
      await store.createRequest(makeNewRequest());
      await store.createRequest(makeNewRequest());
      await store.createRequest(makeNewRequest());

      const provider = mockProvider();
      const providers = new Map([["claude", provider]]);
      const manager = new BatchManager({
        store,
        providers,
        batching: defaultBatching(),
      });

      await manager.flush();

      const queued = await store.getQueuedRequests(100);
      expect(queued).toHaveLength(0); // all should be 'batched' now

      // Get the batch from the submitted batches.
      const inFlight = await store.getInFlightBatches();
      expect(inFlight.length).toBeGreaterThanOrEqual(1);
      expect(inFlight[0].requestCount).toBe(3);
    });
  });
});
