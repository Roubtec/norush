import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import { RequestQueue, estimateBytes } from "../../engine/queue.js";
import type { BatchingConfig } from "../../config/types.js";
import type { NewRequest } from "../../types.js";

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
    maxRequests: 10,
    maxBytes: 50_000_000,
    flushIntervalMs: 0, // disabled by default in tests
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RequestQueue", () => {
  let store: MemoryStore;
  let flushSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new MemoryStore();
    flushSpy = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------

  describe("enqueue", () => {
    it("persists a request with status 'queued'", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
      });

      const result = await queue.enqueue(makeNewRequest());

      expect(result.status).toBe("queued");
      expect(result.id).toBeTruthy();
      expect(result.provider).toBe("claude");
      expect(result.model).toBe("claude-sonnet-4-5-20250929");

      // Verify it's actually in the store.
      const stored = await store.getRequest(result.id);
      expect(stored).toBeTruthy();
      expect(stored?.status).toBe("queued");
    });

    it("assigns a ULID id to each request", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
      });

      const r1 = await queue.enqueue(makeNewRequest());
      const r2 = await queue.enqueue(makeNewRequest());

      // ULIDs are 26 uppercase alphanumeric characters.
      expect(r1.id).toMatch(/^[0-9A-Z]{26}$/);
      expect(r2.id).toMatch(/^[0-9A-Z]{26}$/);
      expect(r1.id).not.toBe(r2.id);
    });

    it("tracks pending count and bytes", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
      });

      expect(queue.pending.count).toBe(0);
      expect(queue.pending.bytes).toBe(0);

      await queue.enqueue(makeNewRequest());

      expect(queue.pending.count).toBe(1);
      expect(queue.pending.bytes).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Flush triggers — count
  // -------------------------------------------------------------------------

  describe("count-based flush trigger", () => {
    it("triggers flush when maxRequests is reached", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ maxRequests: 3 }),
        onFlush: flushSpy,
      });

      await queue.enqueue(makeNewRequest());
      await queue.enqueue(makeNewRequest());
      expect(flushSpy).not.toHaveBeenCalled();

      await queue.enqueue(makeNewRequest());
      expect(flushSpy).toHaveBeenCalledOnce();
    });

    it("resets pending counters after flush", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ maxRequests: 2 }),
        onFlush: flushSpy,
      });

      await queue.enqueue(makeNewRequest());
      await queue.enqueue(makeNewRequest()); // triggers flush
      expect(flushSpy).toHaveBeenCalledOnce();
      expect(queue.pending.count).toBe(0);
      expect(queue.pending.bytes).toBe(0);

      // New requests should start counting from 0.
      await queue.enqueue(makeNewRequest());
      expect(queue.pending.count).toBe(1);
    });

    it("flushes once at exactly maxRequests", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ maxRequests: 1 }),
        onFlush: flushSpy,
      });

      await queue.enqueue(makeNewRequest());
      expect(flushSpy).toHaveBeenCalledOnce();

      await queue.enqueue(makeNewRequest());
      expect(flushSpy).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Flush triggers — bytes
  // -------------------------------------------------------------------------

  describe("byte-based flush trigger", () => {
    it("triggers flush when maxBytes is reached", async () => {
      const req = makeNewRequest();
      const reqBytes = estimateBytes(req);

      const queue = new RequestQueue({
        store,
        // Set maxBytes to just above 2x a single request, so 3rd triggers flush.
        batching: defaultBatching({ maxBytes: reqBytes * 2 + 1 }),
        onFlush: flushSpy,
      });

      await queue.enqueue(req);
      await queue.enqueue(req);
      expect(flushSpy).not.toHaveBeenCalled();

      await queue.enqueue(req);
      expect(flushSpy).toHaveBeenCalledOnce();
    });

    it("triggers flush on first request if it exceeds maxBytes", async () => {
      const req = makeNewRequest({
        params: { messages: [{ role: "user", content: "x".repeat(1000) }] },
      });

      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ maxBytes: 10 }), // tiny limit
        onFlush: flushSpy,
      });

      await queue.enqueue(req);
      expect(flushSpy).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Flush triggers — time
  // -------------------------------------------------------------------------

  describe("time-based flush trigger", () => {
    it("tick() triggers flush when there are pending requests", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
      });

      await queue.enqueue(makeNewRequest());
      expect(flushSpy).not.toHaveBeenCalled();

      await queue.tick();
      expect(flushSpy).toHaveBeenCalledOnce();
    });

    it("tick() does nothing when no pending requests", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
      });

      await queue.tick();
      expect(flushSpy).not.toHaveBeenCalled();
    });

    it("start() enables periodic flush via setInterval", async () => {
      vi.useFakeTimers();

      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ flushIntervalMs: 1000 }),
        onFlush: flushSpy,
      });

      queue.start();

      await queue.enqueue(makeNewRequest());
      expect(flushSpy).not.toHaveBeenCalled();

      // Advance time past the interval.
      await vi.advanceTimersByTimeAsync(1000);
      expect(flushSpy).toHaveBeenCalledOnce();

      await queue.stop();
      vi.useRealTimers();
    });

    it("stop() clears the interval timer", async () => {
      vi.useFakeTimers();

      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ flushIntervalMs: 500 }),
        onFlush: flushSpy,
      });

      queue.start();
      await queue.enqueue(makeNewRequest());

      await queue.stop();

      await vi.advanceTimersByTimeAsync(1000);
      expect(flushSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("stop({ finalFlush: true }) performs a final flush", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
      });

      await queue.enqueue(makeNewRequest());
      await queue.stop({ finalFlush: true });
      expect(flushSpy).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Manual flush
  // -------------------------------------------------------------------------

  describe("manual flush", () => {
    it("flush() fires onFlush regardless of thresholds", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ maxRequests: 100 }),
        onFlush: flushSpy,
      });

      await queue.enqueue(makeNewRequest());
      await queue.flush();
      expect(flushSpy).toHaveBeenCalledOnce();
    });

    it("flush() resets pending counters", async () => {
      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
      });

      await queue.enqueue(makeNewRequest());
      await queue.enqueue(makeNewRequest());
      expect(queue.pending.count).toBe(2);

      await queue.flush();
      expect(queue.pending.count).toBe(0);
      expect(queue.pending.bytes).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent flush guard
  // -------------------------------------------------------------------------

  describe("concurrent flush guard", () => {
    it("prevents overlapping flush calls", async () => {
      let resolveFlush: () => void = () => {};
      const slowFlush = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          }),
      );

      const queue = new RequestQueue({
        store,
        batching: defaultBatching({ maxRequests: 1 }),
        onFlush: slowFlush,
      });

      // First enqueue triggers a flush that hangs.
      const p1 = queue.enqueue(makeNewRequest());

      // Let the microtask queue process so the flush is actually invoked.
      await new Promise((r) => setTimeout(r, 0));
      expect(slowFlush).toHaveBeenCalledOnce();

      // Second enqueue while flush is in progress — should not trigger another.
      const p2 = queue.enqueue(makeNewRequest());
      await new Promise((r) => setTimeout(r, 0));

      // Still just one call — the guard prevented a second.
      expect(slowFlush).toHaveBeenCalledOnce();

      // Resolve the first flush.
      resolveFlush();
      await p1;
      await p2;
    });
  });

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  describe("telemetry", () => {
    it("emits requests_queued counter on enqueue", async () => {
      const counterSpy = vi.fn();
      const telemetry = {
        counter: counterSpy,
        histogram: vi.fn(),
        event: vi.fn(),
      };

      const queue = new RequestQueue({
        store,
        batching: defaultBatching(),
        onFlush: flushSpy,
        telemetry,
      });

      await queue.enqueue(makeNewRequest({ provider: "openai", model: "gpt-4o" }));

      expect(counterSpy).toHaveBeenCalledWith("requests_queued", 1, {
        provider: "openai",
        model: "gpt-4o",
      });
    });
  });

  // -------------------------------------------------------------------------
  // estimateBytes
  // -------------------------------------------------------------------------

  describe("estimateBytes", () => {
    it("returns byte length of serialized params", () => {
      const req = makeNewRequest({
        params: { messages: [{ role: "user", content: "hi" }] },
      });
      const bytes = estimateBytes(req);
      const expected = new TextEncoder().encode(
        JSON.stringify(req.params),
      ).byteLength;
      expect(bytes).toBe(expected);
    });

    it("handles unicode correctly", () => {
      const req = makeNewRequest({
        params: { messages: [{ role: "user", content: "\u{1F600}" }] },
      });
      const bytes = estimateBytes(req);
      // The emoji is 4 bytes in UTF-8.
      expect(bytes).toBeGreaterThan(0);
    });
  });
});
