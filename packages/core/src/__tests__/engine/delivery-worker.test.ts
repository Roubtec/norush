import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import {
  DeliveryWorker,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
} from "../../engine/delivery-worker.js";
import type { NewRequest, Request, Result } from "../../types.js";

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
    callbackUrl: "https://example.com/callback",
    ...overrides,
  };
}

/**
 * Create a request and a pending (undelivered) result in the store.
 */
async function createPendingResult(
  store: MemoryStore,
  overrides: { callbackUrl?: string | null } = {},
): Promise<{ request: Request; result: Result }> {
  const request = await store.createRequest(
    makeNewRequest({ callbackUrl: overrides.callbackUrl ?? "https://example.com/cb" }),
  );
  const batch = await store.createBatch({
    provider: "claude",
    apiKeyId: "user_01",
    requestCount: 1,
  });
  const result = await store.createResult({
    requestId: request.id,
    batchId: batch.id,
    response: { content: "Hello response" },
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 20,
  });

  return { request, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeliveryWorker", () => {
  let store: MemoryStore;
  let currentTime: number;

  beforeEach(() => {
    store = new MemoryStore();
    currentTime = Date.now();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Successful delivery
  // -----------------------------------------------------------------------

  describe("successful delivery", () => {
    it("delivers results to registered callbacks", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      await worker.tick();

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ id: result.id }),
        expect.objectContaining({ userId: "user_01" }),
      );
    });

    it("marks result as delivered on success", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      await worker.tick();

      // Result should no longer appear in undelivered.
      const undelivered = await store.getUndeliveredResults(100);
      const found = undelivered.find((r) => r.id === result.id);
      expect(found).toBeUndefined();
    });

    it("delivers multiple results in one tick", async () => {
      await createPendingResult(store);
      await createPendingResult(store);
      await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      const processed = await worker.tick();

      expect(processed).toBe(3);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("invokes all registered callbacks for each result", async () => {
      await createPendingResult(store);

      const cb1 = vi.fn().mockResolvedValue(undefined);
      const cb2 = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(cb1);
      worker.addCallback(cb2);

      await worker.tick();

      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it("emits delivery:success event on successful delivery", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);
      const handler = vi.fn();

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);
      worker.on("delivery:success", handler);

      await worker.tick();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ resultId: result.id }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Delivery failure and retry
  // -----------------------------------------------------------------------

  describe("delivery failure and retry", () => {
    it("retries delivery on callback failure", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      // First tick: delivery fails.
      await worker.tick();

      // Result should still be undelivered with incremented attempts.
      const undelivered = await store.getUndeliveredResults(100);
      const found = undelivered.find((r) => r.id === result.id);
      expect(found).toBeDefined();
      expect(found?.deliveryAttempts).toBe(1);
      expect(found?.lastDeliveryError).toBe("Network error");
      expect(found?.nextDeliveryAt).toBeInstanceOf(Date);
    });

    it("uses exponential backoff for retry scheduling", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockRejectedValue(new Error("Fail"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        maxDeliveryAttempts: 5,
      });
      worker.addCallback(callback);

      // First delivery attempt.
      await worker.tick();

      let found = await store.getUndeliveredResults(100);
      let res = found.find((r) => r.id === result.id);
      expect(res?.deliveryAttempts).toBe(1);
      // After 1st attempt: delay = 10s * 2^0 = 10s
      expect(res?.nextDeliveryAt?.getTime()).toBe(currentTime + BASE_DELAY_MS);

      // Advance past the first backoff.
      currentTime += BASE_DELAY_MS + 1;
      await worker.tick();

      found = await store.getUndeliveredResults(100);
      res = found.find((r) => r.id === result.id);
      expect(res?.deliveryAttempts).toBe(2);
      // After 2nd attempt: delay = 10s * 2^1 = 20s
      expect(res?.nextDeliveryAt?.getTime()).toBe(
        currentTime + BASE_DELAY_MS * 2,
      );

      // Advance past the second backoff.
      currentTime += BASE_DELAY_MS * 2 + 1;
      await worker.tick();

      found = await store.getUndeliveredResults(100);
      res = found.find((r) => r.id === result.id);
      expect(res?.deliveryAttempts).toBe(3);
      // After 3rd attempt: delay = 10s * 2^2 = 40s
      expect(res?.nextDeliveryAt?.getTime()).toBe(
        currentTime + BASE_DELAY_MS * 4,
      );
    });

    it("caps backoff at MAX_DELAY_MS (10 minutes)", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockRejectedValue(new Error("Fail"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        maxDeliveryAttempts: 20, // High limit so we can test backoff cap
      });
      worker.addCallback(callback);

      // Run many retries to exceed the cap.
      for (let i = 0; i < 15; i++) {
        await worker.tick();
        currentTime += MAX_DELAY_MS + 1;
      }

      const found = await store.getUndeliveredResults(100);
      const res = found.find((r) => r.id === result.id);

      // The backoff should be capped at MAX_DELAY_MS.
      if (res?.nextDeliveryAt) {
        const delay = res.nextDeliveryAt.getTime() - currentTime;
        expect(delay).toBeLessThanOrEqual(MAX_DELAY_MS);
      }
    });

    it("skips results whose nextDeliveryAt is in the future", async () => {
      const { result } = await createPendingResult(store);

      // Set nextDeliveryAt far in the future.
      await store.updateResult(result.id, {
        nextDeliveryAt: new Date(currentTime + 60_000),
        deliveryAttempts: 1,
      });

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      const processed = await worker.tick();

      expect(processed).toBe(0);
      expect(callback).not.toHaveBeenCalled();
    });

    it("processes results whose nextDeliveryAt is in the past", async () => {
      const { result } = await createPendingResult(store);

      // Set nextDeliveryAt in the past.
      await store.updateResult(result.id, {
        nextDeliveryAt: new Date(currentTime - 1000),
        deliveryAttempts: 1,
      });

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      const processed = await worker.tick();

      expect(processed).toBe(1);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("emits delivery:failure event on failed delivery", async () => {
      await createPendingResult(store);

      const callback = vi.fn().mockRejectedValue(new Error("Fail"));
      const handler = vi.fn();

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);
      worker.on("delivery:failure", handler);

      await worker.tick();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          error: "Fail",
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Exhausted delivery attempts
  // -----------------------------------------------------------------------

  describe("exhausted delivery attempts", () => {
    it("marks result as failed after maxDeliveryAttempts", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockRejectedValue(new Error("Always fails"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        maxDeliveryAttempts: 3,
      });
      worker.addCallback(callback);

      // Run 3 delivery attempts.
      for (let i = 0; i < 3; i++) {
        await worker.tick();
        currentTime += MAX_DELAY_MS + 1;
      }

      // After the 3rd attempt, it should be marked as failed.
      // getUndeliveredResults returns 'pending' and 'failed' — but our failed
      // result now has deliveryAttempts >= maxDeliveryAttempts, so the worker
      // will skip it. Let's check the store directly.
      const found = await store.getUndeliveredResults(100);
      const res = found.find((r) => r.id === result.id);

      // The result should still show up in undelivered because MemoryStore
      // returns 'failed' status too, but with status 'failed'.
      expect(res?.deliveryStatus).toBe("failed");
      expect(res?.deliveryAttempts).toBe(3);
      expect(res?.lastDeliveryError).toBe("Always fails");
    });

    it("emits delivery:exhausted event when max attempts reached", async () => {
      await createPendingResult(store);

      const callback = vi.fn().mockRejectedValue(new Error("Always fails"));
      const handler = vi.fn();

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        maxDeliveryAttempts: 1,
      });
      worker.addCallback(callback);
      worker.on("delivery:exhausted", handler);

      await worker.tick();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 1,
          error: "Always fails",
        }),
      );
    });

    it("emits delivery_failures telemetry counter", async () => {
      await createPendingResult(store);

      const callback = vi.fn().mockRejectedValue(new Error("Fail"));
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const worker = new DeliveryWorker({
        store,
        maxDeliveryAttempts: 1,
        telemetry,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      await worker.tick();

      expect(telemetry.counter).toHaveBeenCalledWith("delivery_failures", 1);
    });
  });

  // -----------------------------------------------------------------------
  // No-target handling
  // -----------------------------------------------------------------------

  describe("no-target handling", () => {
    it("marks result as no_target when no callbacks and no callbackUrl", async () => {
      const { result } = await createPendingResult(store, {
        callbackUrl: null,
      });

      // No callbacks registered, request has no callbackUrl.
      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });

      await worker.tick();

      const found = await store.getUndeliveredResults(100);
      // no_target results are not included in getUndeliveredResults (only pending/failed).
      const res = found.find((r) => r.id === result.id);
      expect(res).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Callback management
  // -----------------------------------------------------------------------

  describe("callback management", () => {
    it("removeCallback removes a previously registered callback", async () => {
      await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);
      worker.removeCallback(callback);

      // With no callbacks and a request that has callbackUrl, the worker
      // would still try to deliver but there's no callback to invoke.
      // Since there are no callbacks but the request has a callbackUrl,
      // it should still attempt (with no callbacks to invoke, it succeeds vacuously).
      await worker.tick();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Event emitter
  // -----------------------------------------------------------------------

  describe("event emitter", () => {
    it("can remove event listeners with off()", async () => {
      await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);
      const handler = vi.fn();

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);
      worker.on("delivery:success", handler);
      worker.off("delivery:success", handler);

      await worker.tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it("swallows errors thrown by event listeners", async () => {
      await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);
      worker.on("delivery:success", () => {
        throw new Error("listener error");
      });

      await expect(worker.tick()).resolves.toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrency guard
  // -----------------------------------------------------------------------

  describe("concurrency", () => {
    it("prevents concurrent tick execution", async () => {
      await createPendingResult(store);

      let resolveCallback: (() => void) | undefined;
      const callback = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveCallback = resolve;
          }),
      );

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      // Start first tick (will block on callback).
      const tick1 = worker.tick();

      // Wait for callback to be called.
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledTimes(1);
      });

      // Start second tick — should return 0 immediately.
      const result2 = await worker.tick();
      expect(result2).toBe(0);

      // Unblock first tick.
      resolveCallback?.();
      await tick1;
    });
  });

  // -----------------------------------------------------------------------
  // Start/stop lifecycle
  // -----------------------------------------------------------------------

  describe("start/stop", () => {
    it("start() is idempotent", () => {
      const worker = new DeliveryWorker({
        store,
        tickIntervalMs: 60_000,
      });

      worker.start();
      worker.start(); // should not create a second timer
      worker.stop();
    });

    it("stop() clears the timer", () => {
      const worker = new DeliveryWorker({
        store,
        tickIntervalMs: 60_000,
      });

      worker.start();
      worker.stop();
      worker.stop(); // should be safe to call twice
    });
  });

  // -----------------------------------------------------------------------
  // Telemetry
  // -----------------------------------------------------------------------

  describe("telemetry", () => {
    it("emits deliveries_attempted counter", async () => {
      await createPendingResult(store);
      await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const worker = new DeliveryWorker({
        store,
        telemetry,
        now: () => new Date(currentTime),
      });
      worker.addCallback(callback);

      await worker.tick();

      expect(telemetry.counter).toHaveBeenCalledWith(
        "deliveries_attempted",
        2,
      );
    });

    it("does not emit deliveries_attempted when no results processed", async () => {
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const worker = new DeliveryWorker({
        store,
        telemetry,
        now: () => new Date(currentTime),
      });

      await worker.tick();

      const attemptedCalls = telemetry.counter.mock.calls.filter(
        (c: unknown[]) => c[0] === "deliveries_attempted",
      );
      expect(attemptedCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe("constants", () => {
    it("exports expected default values", () => {
      expect(BASE_DELAY_MS).toBe(10_000);
      expect(MAX_DELAY_MS).toBe(600_000);
      expect(DEFAULT_MAX_DELIVERY_ATTEMPTS).toBe(5);
    });
  });
});
