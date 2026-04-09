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

/** A no-op fetch mock that always returns 200 OK. */
function mockFetchOk(): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(
    new Response("OK", { status: 200, statusText: "OK" }),
  );
}

/**
 * Create a request and a pending (undelivered) result in the store.
 */
async function createPendingResult(
  store: MemoryStore,
  overrides: { callbackUrl?: string | null; maxDeliveryAttempts?: number } = {},
): Promise<{ request: Request; result: Result }> {
  const callbackUrl = "callbackUrl" in overrides
    ? overrides.callbackUrl
    : "https://example.com/cb";
  const request = await store.createRequest(
    makeNewRequest({ callbackUrl }),
  );
  const batch = await store.createBatch({
    provider: "claude",
    apiKeyId: "user_01",
    requestCount: 1,
  });
  let result = await store.createResult({
    requestId: request.id,
    batchId: batch.id,
    response: { content: "Hello response" },
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 20,
  });

  if (overrides.maxDeliveryAttempts !== undefined) {
    await store.updateResult(result.id, {
      maxDeliveryAttempts: overrides.maxDeliveryAttempts,
    });
    // Re-fetch to get the updated value.
    const all = await store.getUndeliveredResults(100);
    const updated = all.find((r) => r.id === result.id);
    if (updated) result = updated;
  }

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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
      const { result } = await createPendingResult(store, {
        maxDeliveryAttempts: 5,
      });

      const callback = vi.fn().mockRejectedValue(new Error("Fail"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
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
      const { result } = await createPendingResult(store, {
        maxDeliveryAttempts: 20, // High limit so we can test backoff cap
      });

      const callback = vi.fn().mockRejectedValue(new Error("Fail"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
      const { result } = await createPendingResult(store, {
        maxDeliveryAttempts: 3,
      });

      const callback = vi.fn().mockRejectedValue(new Error("Always fails"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
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
      await createPendingResult(store, { maxDeliveryAttempts: 1 });

      const callback = vi.fn().mockRejectedValue(new Error("Always fails"));
      const handler = vi.fn();

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
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
      await createPendingResult(store, { maxDeliveryAttempts: 1 });

      const callback = vi.fn().mockRejectedValue(new Error("Fail"));
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const worker = new DeliveryWorker({
        store,
        telemetry,
        now: () => new Date(currentTime),
        fetchFn: mockFetchOk(),
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

    it("delivers via webhook when callbackUrl is set and no callbacks registered", async () => {
      const fetchFn = mockFetchOk();
      const { result } = await createPendingResult(store, {
        callbackUrl: "https://example.com/hook",
      });

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn,
        // No callbacks registered.
      });

      await worker.tick();

      // Webhook delivery should have been attempted.
      expect(fetchFn).toHaveBeenCalledOnce();
      // Result should be delivered (not in undelivered).
      const found = await store.getUndeliveredResults(100);
      const res = found.find((r) => r.id === result.id);
      expect(res).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Orphaned result handling
  // -----------------------------------------------------------------------

  describe("orphaned result handling", () => {
    it("marks orphaned result as permanently failed without infinite retry", async () => {
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      // Create a result whose requestId does not exist in the store.
      const orphanResult = await store.createResult({
        requestId: "req_nonexistent",
        batchId: batch.id,
        response: { content: "orphan" },
      });

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
      });
      worker.addCallback(vi.fn().mockResolvedValue(undefined));

      // First tick: orphan is detected, marked failed with attempts at max.
      await worker.tick();

      const all = await store.getUndeliveredResults(100);
      const orphan = all.find((r) => r.id === orphanResult.id);
      expect(orphan?.deliveryStatus).toBe("failed");
      expect(orphan?.deliveryAttempts).toBeGreaterThanOrEqual(
        orphan?.maxDeliveryAttempts ?? 5,
      );

      // Second tick: orphan is skipped (attempts >= max), so nothing processed.
      const processed = await worker.tick();
      expect(processed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Callback management
  // -----------------------------------------------------------------------

  describe("callback management", () => {
    it("removeCallback removes a previously registered callback", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn: mockFetchOk(),
      });
      worker.addCallback(callback);
      worker.removeCallback(callback);

      // After removing all callbacks there is nothing to deliver to,
      // so the result is marked no_target.
      await worker.tick();

      expect(callback).not.toHaveBeenCalled();

      const updated = (await store.getUndeliveredResults(100)).find(
        (r) => r.id === result.id,
      );
      // no_target results are excluded from getUndeliveredResults.
      expect(updated).toBeUndefined();
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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
        fetchFn: mockFetchOk(),
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

    it("emits delivery_worker.tick_error telemetry when tick throws", async () => {
      const telemetry = { counter: vi.fn(), histogram: vi.fn(), event: vi.fn() };

      const worker = new DeliveryWorker({
        store,
        telemetry,
        tickIntervalMs: 10,
        now: () => new Date(currentTime),
      });

      // Make the store throw on getUndeliveredResults to simulate a tick error.
      vi.spyOn(store, "getUndeliveredResults").mockRejectedValueOnce(
        new Error("store unavailable"),
      );

      worker.start();

      // Wait for at least one tick to fire and the error to be emitted.
      await vi.waitFor(() => {
        expect(telemetry.event).toHaveBeenCalledWith(
          "delivery_worker.tick_error",
          expect.objectContaining({ message: "store unavailable" }),
        );
      });

      worker.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Webhook delivery integration
  // -----------------------------------------------------------------------

  describe("webhook delivery", () => {
    it("POSTs to callbackUrl when set on the request", async () => {
      const fetchFn = mockFetchOk();
      await createPendingResult(store);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn,
      });

      await worker.tick();

      expect(fetchFn).toHaveBeenCalledOnce();
      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://example.com/cb");
      expect(init.method).toBe("POST");
    });

    it("does not POST when callbackUrl is null", async () => {
      const fetchFn = mockFetchOk();
      await createPendingResult(store, { callbackUrl: null });

      // Register a callback so it's not marked as no_target.
      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn,
      });
      worker.addCallback(callback);

      await worker.tick();

      expect(fetchFn).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledOnce();
    });

    it("includes HMAC signature when webhookSecret is set", async () => {
      const fetchFn = mockFetchOk();
      const request = await store.createRequest(
        makeNewRequest({
          callbackUrl: "https://example.com/hook",
          webhookSecret: "my-secret",
        }),
      );
      const batch = await store.createBatch({
        provider: "claude",
        apiKeyId: "user_01",
        requestCount: 1,
      });
      await store.createResult({
        requestId: request.id,
        batchId: batch.id,
        response: { content: "Hello" },
        inputTokens: 10,
        outputTokens: 20,
      });

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn,
      });

      await worker.tick();

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Norush-Signature"]).toBeDefined();
      expect(headers["X-Norush-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it("omits signature when no webhookSecret", async () => {
      const fetchFn = mockFetchOk();
      await createPendingResult(store);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn,
      });

      await worker.tick();

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Norush-Signature"]).toBeUndefined();
    });

    it("retries on webhook delivery failure (non-2xx)", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
      );

      const { result } = await createPendingResult(store);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn: fetchFn as typeof globalThis.fetch,
      });

      await worker.tick();

      const undelivered = await store.getUndeliveredResults(100);
      const found = undelivered.find((r) => r.id === result.id);
      expect(found).toBeDefined();
      expect(found?.deliveryAttempts).toBe(1);
      expect(found?.lastDeliveryError).toMatch(/500/);
    });

    it("marks as failed after max webhook delivery attempts", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        new Response("Error", { status: 502, statusText: "Bad Gateway" }),
      );

      const { result } = await createPendingResult(store, { maxDeliveryAttempts: 2 });

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn: fetchFn as typeof globalThis.fetch,
      });

      // First attempt
      await worker.tick();
      currentTime += MAX_DELAY_MS + 1;

      // Second attempt (exhausts max attempts)
      await worker.tick();

      const undelivered = await store.getUndeliveredResults(100);
      const found = undelivered.find((r) => r.id === result.id);
      expect(found?.deliveryStatus).toBe("failed");
      expect(found?.deliveryAttempts).toBe(2);
    });

    it("includes norush_id in the webhook payload", async () => {
      const fetchFn = mockFetchOk();
      const { request } = await createPendingResult(store);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn,
      });

      await worker.tick();

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.norush_id).toBe(request.id);
    });

    it("includes X-Norush-Attempt and X-Norush-Request-Id headers", async () => {
      const fetchFn = mockFetchOk();
      const { request } = await createPendingResult(store);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn,
      });

      await worker.tick();

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Norush-Attempt"]).toBe("1");
      expect(headers["X-Norush-Request-Id"]).toBe(request.id);
    });
  });

  // -----------------------------------------------------------------------
  // Event logging
  // -----------------------------------------------------------------------

  describe("event logging", () => {
    it("logs a webhook_delivered event on successful delivery", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockResolvedValue(undefined);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn: mockFetchOk(),
      });
      worker.addCallback(callback);

      await worker.tick();

      const events = store.getEvents();
      const deliveredEvent = events.find(
        (e) => e.event === "webhook_delivered" && e.entityId === result.id,
      );
      expect(deliveredEvent).toBeDefined();
      expect(deliveredEvent?.entityType).toBe("result");
      expect(deliveredEvent?.details?.requestId).toBe(result.requestId);
      expect(deliveredEvent?.details?.attempt).toBe(1);
    });

    it("logs a webhook_delivery_failed event on retryable failure", async () => {
      const { result } = await createPendingResult(store);

      const callback = vi.fn().mockRejectedValue(new Error("Network error"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn: mockFetchOk(),
      });
      worker.addCallback(callback);

      await worker.tick();

      const events = store.getEvents();
      const failedEvent = events.find(
        (e) =>
          e.event === "webhook_delivery_failed" && e.entityId === result.id,
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.entityType).toBe("result");
      expect(failedEvent?.details?.error).toBe("Network error");
      expect(failedEvent?.details?.attempt).toBe(1);
    });

    it("logs a webhook_delivery_exhausted event after max attempts", async () => {
      const { result } = await createPendingResult(store, { maxDeliveryAttempts: 1 });

      const callback = vi.fn().mockRejectedValue(new Error("Always fails"));

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn: mockFetchOk(),
      });
      worker.addCallback(callback);

      await worker.tick();

      const events = store.getEvents();
      const exhaustedEvent = events.find(
        (e) =>
          e.event === "webhook_delivery_exhausted" &&
          e.entityId === result.id,
      );
      expect(exhaustedEvent).toBeDefined();
      expect(exhaustedEvent?.entityType).toBe("result");
      expect(exhaustedEvent?.details?.attempts).toBe(1);
      expect(exhaustedEvent?.details?.error).toBe("Always fails");
    });

    it("logs events for webhook HTTP delivery failures", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        new Response("Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );

      const { result } = await createPendingResult(store);

      const worker = new DeliveryWorker({
        store,
        now: () => new Date(currentTime),
        fetchFn: fetchFn as typeof globalThis.fetch,
      });

      await worker.tick();

      const events = store.getEvents();
      const failedEvent = events.find(
        (e) =>
          e.event === "webhook_delivery_failed" && e.entityId === result.id,
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.details?.error).toMatch(/500/);
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
