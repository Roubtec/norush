import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { OrphanRecovery } from "../../engine/orphan-recovery.js";
import type { Provider } from "../../interfaces/provider.js";
import type { NewRequest, ProviderBatchRef } from "../../types.js";

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
      providerBatchId: "provider_batch_recovered",
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

describe("OrphanRecovery", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // -----------------------------------------------------------------------
  // No orphans
  // -----------------------------------------------------------------------

  describe("no orphans", () => {
    it("does nothing when there are no pending batches", async () => {
      const provider = mockProvider();
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
      });

      const result = await recovery.recover();

      expect(result).toEqual({ recovered: 0, failed: 0 });
      expect(provider.submitBatch).not.toHaveBeenCalled();
    });

    it("ignores pending batches that already have a provider batch ID", async () => {
      // Create a batch that is pending but has a provider batch ID (not an orphan).
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, {
        providerBatchId: "some_provider_id",
      });

      const provider = mockProvider();
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 0, // no grace period for test
      });

      const result = await recovery.recover();

      expect(result).toEqual({ recovered: 0, failed: 0 });
      expect(provider.submitBatch).not.toHaveBeenCalled();
    });

    it("ignores batches that are too recent (within grace period)", async () => {
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      const provider = mockProvider();
      // Grace period is 5 minutes, batch was just created — should skip.
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 300_000,
      });

      const result = await recovery.recover();

      expect(result).toEqual({ recovered: 0, failed: 0 });
      expect(provider.submitBatch).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Orphan detection and recovery
  // -----------------------------------------------------------------------

  describe("orphan recovery", () => {
    it("resubmits an orphaned batch", async () => {
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      const provider = mockProvider();
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      // Set 'now' to be 10 minutes in the future so the batch is past grace period.
      const futureNow = new Date(Date.now() + 10 * 60 * 1000);
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 300_000,
        telemetry,
        now: () => futureNow,
      });

      const result = await recovery.recover();

      expect(result).toEqual({ recovered: 1, failed: 0 });
      expect(provider.submitBatch).toHaveBeenCalledOnce();

      // Batch should be updated to 'submitted' with provider batch ID.
      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("submitted");
      expect(updated?.providerBatchId).toBe("provider_batch_recovered");
      expect(updated?.submissionAttempts).toBe(2);

      // Telemetry event should be emitted.
      expect(telemetry.event).toHaveBeenCalledWith(
        "orphan_recovered",
        expect.objectContaining({
          batchId: batch.id,
          providerBatchId: "provider_batch_recovered",
        }),
      );
    });

    it("increments submission attempts before calling provider", async () => {
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      let attemptsDuringSubmit: number | undefined;
      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async () => {
          const b = await store.getBatch(batch.id);
          attemptsDuringSubmit = b?.submissionAttempts;
          return { providerBatchId: "pb_001", provider: "claude" as const };
        }),
      });

      const futureNow = new Date(Date.now() + 10 * 60 * 1000);
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 0,
        now: () => futureNow,
      });

      await recovery.recover();

      expect(attemptsDuringSubmit).toBe(2); // was 1, incremented to 2 before call
    });

    it("passes correct NorushRequest to provider", async () => {
      const req = await store.createRequest(
        makeNewRequest({
          params: { max_tokens: 2048, messages: [{ role: "user", content: "test" }] },
        }),
      );
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      const provider = mockProvider();
      const futureNow = new Date(Date.now() + 10 * 60 * 1000);
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 0,
        now: () => futureNow,
      });

      await recovery.recover();

      const submitted = (provider.submitBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(submitted).toHaveLength(1);
      expect(submitted[0].id).toBe(req.id);
      expect(submitted[0].provider).toBe("claude");
      expect(submitted[0].params).toEqual({
        max_tokens: 2048,
        messages: [{ role: "user", content: "test" }],
      });
    });
  });

  // -----------------------------------------------------------------------
  // Max attempts cap
  // -----------------------------------------------------------------------

  describe("max attempts cap", () => {
    it("marks batch as failed when submission attempts are at max", async () => {
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
        maxSubmissionAttempts: 3,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 3 }); // at max

      const provider = mockProvider();
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };
      const futureNow = new Date(Date.now() + 10 * 60 * 1000);
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 0,
        telemetry,
        now: () => futureNow,
      });

      const result = await recovery.recover();

      expect(result).toEqual({ recovered: 0, failed: 1 });
      expect(provider.submitBatch).not.toHaveBeenCalled();

      // Batch should be marked failed.
      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("failed");

      // Request should also be failed.
      const updatedReq = await store.getRequest(req.id);
      expect(updatedReq?.status).toBe("failed");

      expect(telemetry.event).toHaveBeenCalledWith(
        "orphan_failed",
        expect.objectContaining({
          batchId: batch.id,
          submissionAttempts: 3,
          maxSubmissionAttempts: 3,
        }),
      );
    });

    it("fails batch when resubmit error pushes attempts to max", async () => {
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
        maxSubmissionAttempts: 2,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 }); // one away from max

      const provider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error("API down")),
      });

      const futureNow = new Date(Date.now() + 10 * 60 * 1000);
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 0,
        now: () => futureNow,
      });

      const result = await recovery.recover();

      expect(result).toEqual({ recovered: 0, failed: 1 });

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.submissionAttempts).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Resubmission failure
  // -----------------------------------------------------------------------

  describe("resubmission failure", () => {
    it("leaves batch pending when resubmit fails but not at max", async () => {
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
        maxSubmissionAttempts: 5,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      const provider = mockProvider({
        submitBatch: vi.fn().mockRejectedValue(new Error("Temporary failure")),
      });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };
      const futureNow = new Date(Date.now() + 10 * 60 * 1000);
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 0,
        telemetry,
        now: () => futureNow,
      });

      const result = await recovery.recover();

      // Not recovered, but also not at max — so neither recovered nor failed.
      expect(result).toEqual({ recovered: 0, failed: 0 });

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("pending"); // still pending
      expect(updated?.submissionAttempts).toBe(2);

      expect(telemetry.event).toHaveBeenCalledWith(
        "orphan_recovery_error",
        expect.objectContaining({
          batchId: batch.id,
          error: "Temporary failure",
        }),
      );
    });

    it("emits error when no provider adapter is found", async () => {
      const req = await store.createRequest(makeNewRequest({ provider: "openai", model: "gpt-4o" }));
      const batch = await store.createBatch({
        provider: "openai",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };
      // No openai provider registered.
      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", mockProvider()]]),
        gracePeriodMs: 0,
        telemetry,
        now: () => new Date(Date.now() + 10 * 60 * 1000),
      });

      await recovery.recover();

      expect(telemetry.event).toHaveBeenCalledWith(
        "orphan_recovery_error",
        expect.objectContaining({
          error: expect.stringContaining("No provider adapter"),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Provider adapter resolution
  // -----------------------------------------------------------------------

  describe("adapter resolution", () => {
    it("resolves adapter by provider::apiKeyId first", async () => {
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      const specificProvider = mockProvider();
      const fallbackProvider = mockProvider();

      const recovery = new OrphanRecovery({
        store,
        providers: new Map([
          ["claude::user_01", specificProvider],
          ["claude", fallbackProvider],
        ]),
        gracePeriodMs: 0,
        now: () => new Date(Date.now() + 10 * 60 * 1000),
      });

      await recovery.recover();

      expect(specificProvider.submitBatch).toHaveBeenCalledOnce();
      expect(fallbackProvider.submitBatch).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple orphans
  // -----------------------------------------------------------------------

  describe("multiple orphans", () => {
    it("processes multiple orphans in one recovery cycle", async () => {
      // Create 3 orphaned batches.
      for (let i = 0; i < 3; i++) {
        const req = await store.createRequest(makeNewRequest());
        const batch = await store.createBatch({
          provider: "claude",
          apiKeyId: "user_01",
          requestCount: 1,
        });
        await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
        await store.updateBatch(batch.id, { submissionAttempts: 1 });
      }

      let callCount = 0;
      const provider = mockProvider({
        submitBatch: vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            providerBatchId: `pb_${callCount}`,
            provider: "claude" as const,
          };
        }),
      });

      const recovery = new OrphanRecovery({
        store,
        providers: new Map([["claude", provider]]),
        gracePeriodMs: 0,
        now: () => new Date(Date.now() + 10 * 60 * 1000),
      });

      const result = await recovery.recover();

      expect(result).toEqual({ recovered: 3, failed: 0 });
      expect(provider.submitBatch).toHaveBeenCalledTimes(3);
    });
  });
});
