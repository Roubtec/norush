import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { StatusTracker } from "../../engine/status-tracker.js";
import type { Provider } from "../../interfaces/provider.js";
import type { Batch, BatchStatus, NewRequest, ProviderBatchRef } from "../../types.js";

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
    checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
    fetchResults: vi.fn(),
    cancelBatch: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a submitted, in-flight batch in the store with associated requests.
 */
async function createInFlightBatch(
  store: MemoryStore,
  options: {
    provider?: "claude" | "openai";
    status?: BatchStatus;
    providerBatchId?: string;
    pollingStrategy?: string;
  } = {},
): Promise<Batch> {
  const {
    provider = "claude",
    status = "submitted",
    providerBatchId = "pb_001",
    pollingStrategy,
  } = options;

  const req = await store.createRequest(makeNewRequest({ provider }));
  const batch = await store.createBatch({
    provider,
    apiKeyId: "user_01",
    requestCount: 1,
    pollingStrategy: pollingStrategy ?? null,
  });

  await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
  await store.updateBatch(batch.id, {
    status,
    providerBatchId,
    submittedAt: new Date(),
    submissionAttempts: 1,
  });

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test helper, batch was just created
  return (await store.getBatch(batch.id))!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatusTracker", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Basic polling cycle
  // -----------------------------------------------------------------------

  describe("polling cycle", () => {
    it("polls in-flight batches and updates status", async () => {
      const batch = await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      expect(provider.checkStatus).toHaveBeenCalledOnce();
      expect(provider.checkStatus).toHaveBeenCalledWith({
        providerBatchId: "pb_001",
        provider: "claude",
      });

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("processing");
    });

    it("does nothing when there are no in-flight batches", async () => {
      const provider = mockProvider();
      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      expect(provider.checkStatus).not.toHaveBeenCalled();
    });

    it("does not update batch when status has not changed", async () => {
      await createInFlightBatch(store, { status: "processing" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const updateSpy = vi.spyOn(store, "updateBatch");

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      // updateBatch should NOT have been called for a no-change transition.
      // (It was called initially to set up the batch.)
      const statusUpdateCalls = updateSpy.mock.calls.filter(
        (c) => (c[1] as Partial<Batch>).status !== undefined,
      );
      expect(statusUpdateCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Status transitions
  // -----------------------------------------------------------------------

  describe("status transitions", () => {
    it("transitions submitted -> processing", async () => {
      const batch = await createInFlightBatch(store, { status: "submitted" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("processing");
    });

    it("transitions processing -> ended", async () => {
      const batch = await createInFlightBatch(store, { status: "processing" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("ended");
      expect(updated?.endedAt).toBeInstanceOf(Date);
    });

    it("transitions to expired with endedAt", async () => {
      const batch = await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("expired" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("expired");
      expect(updated?.endedAt).toBeInstanceOf(Date);
    });

    it("transitions to failed with endedAt", async () => {
      const batch = await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("failed" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.endedAt).toBeInstanceOf(Date);
    });

    it("transitions to cancelled with endedAt", async () => {
      const batch = await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("cancelled" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      const updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("cancelled");
      expect(updated?.endedAt).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  describe("event emission", () => {
    it("emits batch:processing when status changes to processing", async () => {
      await createInFlightBatch(store, { status: "submitted" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      const handler = vi.fn();
      tracker.on("batch:processing", handler);

      await tracker.tick();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          newStatus: "processing",
          previousStatus: "submitted",
        }),
      );
    });

    it("emits batch:completed when status changes to ended", async () => {
      await createInFlightBatch(store, { status: "processing" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      const handler = vi.fn();
      tracker.on("batch:completed", handler);

      await tracker.tick();

      expect(handler).toHaveBeenCalledOnce();
    });

    it("emits batch:expired when status changes to expired", async () => {
      await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("expired" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      const handler = vi.fn();
      tracker.on("batch:expired", handler);

      await tracker.tick();

      expect(handler).toHaveBeenCalledOnce();
    });

    it("emits batch:failed when status changes to failed", async () => {
      await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("failed" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      const handler = vi.fn();
      tracker.on("batch:failed", handler);

      await tracker.tick();

      expect(handler).toHaveBeenCalledOnce();
    });

    it("emits batch:error when status changes to cancelled", async () => {
      await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("cancelled" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      const handler = vi.fn();
      tracker.on("batch:error", handler);

      await tracker.tick();

      expect(handler).toHaveBeenCalledOnce();
    });

    it("can remove event listeners with off()", async () => {
      await createInFlightBatch(store, { status: "submitted" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      const handler = vi.fn();
      tracker.on("batch:processing", handler);
      tracker.off("batch:processing", handler);

      await tracker.tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it("swallows errors thrown by event listeners", async () => {
      await createInFlightBatch(store, { status: "submitted" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      tracker.on("batch:processing", () => {
        throw new Error("listener error");
      });

      // Should not throw.
      await expect(tracker.tick()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Polling strategy
  // -----------------------------------------------------------------------

  describe("polling strategy", () => {
    it("uses the default polling strategy when batch has none", async () => {
      await createInFlightBatch(store, { pollingStrategy: undefined });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        defaultPollingStrategy: "linear",
      });

      // First tick should always poll (no lastPolledAt).
      await tracker.tick();
      expect(provider.checkStatus).toHaveBeenCalledOnce();
    });

    it("respects polling interval between ticks", async () => {
      await createInFlightBatch(store);

      let currentTime = 1000;
      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("submitted" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        defaultPollingStrategy: "linear", // 60s default interval
        now: () => new Date(currentTime),
      });

      // First tick — should poll (no previous poll).
      await tracker.tick();
      expect(provider.checkStatus).toHaveBeenCalledTimes(1);

      // Second tick — 10 seconds later — should NOT poll.
      currentTime += 10_000;
      await tracker.tick();
      expect(provider.checkStatus).toHaveBeenCalledTimes(1);

      // Third tick — 60 seconds after first poll — should poll.
      currentTime = 1000 + 60_000;
      await tracker.tick();
      expect(provider.checkStatus).toHaveBeenCalledTimes(2);
    });

    it("uses batch-specific polling strategy when set", async () => {
      await createInFlightBatch(store, { pollingStrategy: "eager" });

      let currentTime = 1000;
      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("submitted" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        defaultPollingStrategy: "linear", // would be 60s
        now: () => new Date(currentTime),
      });

      // First tick polls.
      await tracker.tick();
      expect(provider.checkStatus).toHaveBeenCalledTimes(1);

      // Eager strategy uses 15s interval for first 5 min.
      // After 15 seconds, should poll again.
      currentTime += 15_000;
      await tracker.tick();
      expect(provider.checkStatus).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("handles checkStatus errors gracefully", async () => {
      await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockRejectedValue(new Error("Network error")),
      });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        telemetry,
      });

      // Should not throw.
      await expect(tracker.tick()).resolves.toBeUndefined();

      expect(telemetry.event).toHaveBeenCalledWith(
        "status_check_error",
        expect.objectContaining({
          error: "Network error",
        }),
      );
    });

    it("handles missing provider adapter gracefully", async () => {
      await createInFlightBatch(store, { provider: "openai" });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", mockProvider()]]), // no openai
        telemetry,
      });

      await tracker.tick();

      expect(telemetry.event).toHaveBeenCalledWith(
        "status_check_error",
        expect.objectContaining({
          error: expect.stringContaining("No provider adapter"),
        }),
      );
    });

    it("prevents concurrent tick execution", async () => {
      await createInFlightBatch(store);

      let resolveCheck: ((value: BatchStatus) => void) | undefined;
      const provider = mockProvider({
        checkStatus: vi.fn().mockImplementation(
          () =>
            new Promise<BatchStatus>((resolve) => {
              resolveCheck = resolve;
            }),
        ),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      // Start first tick (will block on checkStatus).
      const tick1 = tracker.tick();

      // Wait for the first tick to reach the checkStatus call.
      // We know it's reached when the mock has been called.
      await vi.waitFor(() => {
        expect(provider.checkStatus).toHaveBeenCalledTimes(1);
      });

      // Start second tick — should return immediately (ticking guard).
      const tick2 = tracker.tick();
      await tick2; // resolves immediately

      // Provider should still only have been called once.
      expect(provider.checkStatus).toHaveBeenCalledTimes(1);

      // Unblock first tick.
      resolveCheck?.("processing");
      await tick1;
    });
  });

  // -----------------------------------------------------------------------
  // Circuit breaker integration
  // -----------------------------------------------------------------------

  describe("circuit breaker integration", () => {
    it("records failure on batch failure and trips after threshold", async () => {
      // Create multiple batches that will all report as failed.
      for (let i = 0; i < 5; i++) {
        await createInFlightBatch(store, { providerBatchId: `pb_${i}` });
      }

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("failed" as BatchStatus),
      });

      const events: string[] = [];
      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        circuitBreaker: { threshold: 3 },
      });

      tracker.on("batch:failed", () => events.push("batch:failed"));
      tracker.on("circuit_breaker:tripped", () => events.push("circuit_breaker:tripped"));

      await tracker.tick();

      // All 5 batches should fail.
      expect(events.filter((e) => e === "batch:failed")).toHaveLength(5);

      // Circuit breaker should have tripped (after the 3rd failure).
      expect(events.filter((e) => e === "circuit_breaker:tripped").length).toBeGreaterThanOrEqual(1);
      expect(tracker.circuitBreaker.state).toBe("open");
    });

    it("exposes circuit breaker for external inspection", () => {
      const tracker = new StatusTracker({
        store,
        providers: new Map(),
        circuitBreaker: { threshold: 10 },
      });

      expect(tracker.circuitBreaker.state).toBe("closed");
      expect(tracker.circuitBreaker.canSubmit()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Orphan recovery integration
  // -----------------------------------------------------------------------

  describe("orphan recovery integration", () => {
    it("runs orphan recovery during tick", async () => {
      // Create an orphaned batch (pending, no provider_batch_id, old enough).
      const req = await store.createRequest(makeNewRequest());
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.updateRequest(req.id, { batchId: batch.id, status: "batched" });
      await store.updateBatch(batch.id, { submissionAttempts: 1 });

      const provider = mockProvider({
        // checkStatus returns 'processing' — after orphan recovery submits
        // the batch, the tick also polls it and transitions to 'processing'.
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const futureNow = new Date(Date.now() + 10 * 60 * 1000);
      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        telemetry,
        orphanGracePeriodMs: 300_000,
        now: () => futureNow,
      });

      await tracker.tick();

      // Orphan was recovered — it now has a provider batch ID.
      const updated = await store.getBatch(batch.id);
      expect(updated?.providerBatchId).toBe("provider_batch_001");
      // After recovery, the tick also polled it and it transitioned to processing.
      expect(updated?.status).toBe("processing");

      expect(telemetry.counter).toHaveBeenCalledWith("orphans_recovered", 1);
    });
  });

  // -----------------------------------------------------------------------
  // Start/stop lifecycle
  // -----------------------------------------------------------------------

  describe("start/stop", () => {
    it("start() is idempotent", () => {
      const tracker = new StatusTracker({
        store,
        providers: new Map(),
        tickIntervalMs: 60_000,
      });

      tracker.start();
      tracker.start(); // should not create a second timer

      tracker.stop();
    });

    it("stop() clears the timer", () => {
      const tracker = new StatusTracker({
        store,
        providers: new Map(),
        tickIntervalMs: 60_000,
      });

      tracker.start();
      tracker.stop();

      // Calling stop again should be safe.
      tracker.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple batches
  // -----------------------------------------------------------------------

  describe("multiple batches", () => {
    it("polls multiple in-flight batches in one tick", async () => {
      await createInFlightBatch(store, { providerBatchId: "pb_1" });
      await createInFlightBatch(store, { providerBatchId: "pb_2" });
      await createInFlightBatch(store, { providerBatchId: "pb_3" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      expect(provider.checkStatus).toHaveBeenCalledTimes(3);
    });

    it("handles mixed status results across batches", async () => {
      const batch1 = await createInFlightBatch(store, { providerBatchId: "pb_1" });
      const batch2 = await createInFlightBatch(store, { providerBatchId: "pb_2" });
      const batch3 = await createInFlightBatch(store, { providerBatchId: "pb_3" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockImplementation(async (ref: ProviderBatchRef) => {
          switch (ref.providerBatchId) {
            case "pb_1":
              return "processing" as BatchStatus;
            case "pb_2":
              return "ended" as BatchStatus;
            case "pb_3":
              return "expired" as BatchStatus;
            default:
              return "submitted" as BatchStatus;
          }
        }),
      });

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
      });

      await tracker.tick();

      const updated1 = await store.getBatch(batch1.id);
      const updated2 = await store.getBatch(batch2.id);
      const updated3 = await store.getBatch(batch3.id);

      expect(updated1?.status).toBe("processing");
      expect(updated2?.status).toBe("ended");
      expect(updated3?.status).toBe("expired");
    });
  });

  // -----------------------------------------------------------------------
  // Poll state cleanup
  // -----------------------------------------------------------------------

  describe("poll state cleanup", () => {
    it("cleans up poll state for completed batches", async () => {
      const batch = await createInFlightBatch(store);

      let callCount = 0;
      const provider = mockProvider({
        checkStatus: vi.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1 ? ("processing" as BatchStatus) : ("ended" as BatchStatus);
        }),
      });

      let currentTime = 1000;
      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        now: () => new Date(currentTime),
      });

      // First tick: batch transitions to processing (still in-flight).
      await tracker.tick();
      let updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("processing");

      // Advance time past the linear strategy interval (60s).
      currentTime += 61_000;

      // Second tick: batch transitions to ended (no longer in-flight).
      await tracker.tick();
      updated = await store.getBatch(batch.id);
      expect(updated?.status).toBe("ended");

      // Advance time again.
      currentTime += 61_000;

      // Third tick: batch should no longer be polled.
      await tracker.tick();
      // checkStatus called only 2 times total (not 3).
      expect(provider.checkStatus).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Telemetry
  // -----------------------------------------------------------------------

  describe("telemetry", () => {
    it("emits batches_polled counter on each poll", async () => {
      await createInFlightBatch(store);

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        telemetry,
      });

      await tracker.tick();

      expect(telemetry.counter).toHaveBeenCalledWith(
        "batches_polled",
        1,
        { provider: "claude" },
      );
    });

    it("emits status transition events via telemetry", async () => {
      await createInFlightBatch(store, { status: "submitted" });

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
      });

      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const tracker = new StatusTracker({
        store,
        providers: new Map([["claude", provider]]),
        telemetry,
      });

      await tracker.tick();

      expect(telemetry.event).toHaveBeenCalledWith(
        "batch:processing",
        expect.objectContaining({
          previousStatus: "submitted",
          newStatus: "processing",
        }),
      );
    });
  });
});
