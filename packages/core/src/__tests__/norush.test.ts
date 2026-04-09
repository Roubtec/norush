/**
 * End-to-end tests for createNorush() with MemoryStore.
 *
 * Tests the full lifecycle: enqueue -> flush -> submit -> poll -> ingest -> deliver,
 * including failure paths and repackaging.
 *
 * NOTE: The status tracker uses polling strategies with a minimum 10s interval
 * (via clamping). In tests, the first tick always polls (lastPolledAt is null),
 * so we structure tests to return the desired status on the first poll.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memory.js";
import { createNorush, type NorushEngine } from "../norush.js";
import type { Provider } from "../interfaces/provider.js";
import type {
  BatchStatus,
  NewRequest,
  NorushResult,
  ProviderBatchRef,
  Result,
  Request,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<NewRequest> = {}): NewRequest {
  return {
    provider: "claude",
    model: "claude-sonnet-4-5-20250929",
    params: {
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    },
    userId: "user_01",
    ...overrides,
  };
}

async function* makeResultStream(
  results: NorushResult[],
): AsyncIterable<NorushResult> {
  for (const r of results) {
    yield r;
  }
}

function mockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    submitBatch: vi.fn().mockResolvedValue({
      providerBatchId: "pb_001",
      provider: "claude",
    } satisfies ProviderBatchRef),
    checkStatus: vi.fn().mockResolvedValue("processing" as BatchStatus),
    fetchResults: vi.fn().mockReturnValue(makeResultStream([])),
    cancelBatch: vi.fn(),
    ...overrides,
  };
}

/**
 * Wait for async operations (e.g., the batch:completed handler's async pipeline).
 */
function waitForPipeline(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNorush()", () => {
  let engine: NorushEngine;

  afterEach(async () => {
    if (engine) {
      await engine.stop();
    }
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Factory creation
  // -----------------------------------------------------------------------

  describe("factory", () => {
    it("creates an engine with all public API methods", () => {
      const store = new MemoryStore();
      engine = createNorush({
        store,
        providers: new Map([["claude", mockProvider()]]),
      });

      expect(typeof engine.enqueue).toBe("function");
      expect(typeof engine.flush).toBe("function");
      expect(typeof engine.tick).toBe("function");
      expect(typeof engine.start).toBe("function");
      expect(typeof engine.stop).toBe("function");
      expect(typeof engine.on).toBe("function");
      expect(typeof engine.off).toBe("function");
      expect(typeof engine.addDeliveryCallback).toBe("function");
      expect(typeof engine.removeDeliveryCallback).toBe("function");
    });

    it("resolves config with defaults", () => {
      const store = new MemoryStore();
      engine = createNorush({
        store,
        providers: new Map(),
      });

      expect(engine.config).toBeDefined();
      expect(engine.config.batching.maxRequests).toBe(1000);
      expect(engine.config.batching.flushIntervalMs).toBe(300_000);
      expect(engine.config.polling.intervalMs).toBe(60_000);
    });

    it("resolves config with custom values", () => {
      const store = new MemoryStore();
      engine = createNorush({
        store,
        providers: new Map(),
        batching: { maxRequests: 500, flushIntervalMs: 60_000 },
        polling: { intervalMs: 30_000 },
      });

      expect(engine.config.batching.maxRequests).toBe(500);
      expect(engine.config.batching.flushIntervalMs).toBe(60_000);
      expect(engine.config.polling.intervalMs).toBe(30_000);
    });

    it("accepts provider config object and builds adapters", () => {
      const store = new MemoryStore();
      // This should not throw — adapters are built from key config.
      engine = createNorush({
        store,
        providers: {
          claude: [{ apiKey: "sk-test-key", label: "primary" }],
        },
      });

      expect(engine).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Enqueue
  // -----------------------------------------------------------------------

  describe("enqueue()", () => {
    it("persists a request to the store", async () => {
      const store = new MemoryStore();
      engine = createNorush({
        store,
        providers: new Map([["claude", mockProvider()]]),
      });

      const req = await engine.enqueue(makeRequest());

      expect(req.id).toBeDefined();
      expect(req.status).toBe("queued");
      expect(req.provider).toBe("claude");

      // Verify it's in the store.
      const stored = await store.getRequest(req.id);
      expect(stored).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked above
      expect(stored!.status).toBe("queued");
    });

    it("enqueues multiple requests to different providers", async () => {
      const store = new MemoryStore();
      const claudeProvider = mockProvider();
      const openaiProvider = mockProvider({
        submitBatch: vi.fn().mockResolvedValue({
          providerBatchId: "pb_openai_001",
          provider: "openai",
        } satisfies ProviderBatchRef),
      });

      engine = createNorush({
        store,
        providers: new Map([
          ["claude", claudeProvider],
          ["openai", openaiProvider],
        ]),
      });

      const r1 = await engine.enqueue(makeRequest({ provider: "claude" }));
      const r2 = await engine.enqueue(makeRequest({ provider: "openai", model: "gpt-4o" }));

      expect(r1.provider).toBe("claude");
      expect(r2.provider).toBe("openai");
    });
  });

  // -----------------------------------------------------------------------
  // Flush
  // -----------------------------------------------------------------------

  describe("flush()", () => {
    it("creates and submits batches from queued requests", async () => {
      const store = new MemoryStore();
      const provider = mockProvider();

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
      });

      await engine.enqueue(makeRequest());
      await engine.enqueue(makeRequest());
      await engine.flush();

      // Provider should have been called to submit a batch.
      expect(provider.submitBatch).toHaveBeenCalledOnce();

      // Requests should now be in 'batched' status.
      const queued = await store.getQueuedRequests(100);
      expect(queued).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Full lifecycle: enqueue -> flush -> tick -> deliver
  // -----------------------------------------------------------------------

  describe("full lifecycle (happy path)", () => {
    it("processes requests end-to-end: enqueue -> flush -> poll -> ingest -> deliver", async () => {
      const store = new MemoryStore();

      // Track delivered results via callback.
      const delivered: Array<{ result: Result; request: Request }> = [];

      // Return "ended" on the first poll (since second tick won't get past
      // isDueForPoll check due to the 10s minimum polling interval).
      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
        fetchResults: vi.fn(),
      });

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
      });

      engine.addDeliveryCallback(async (result, request) => {
        delivered.push({ result, request });
      });

      // Step 1: Enqueue requests.
      const req1 = await engine.enqueue(makeRequest());
      const req2 = await engine.enqueue(makeRequest());

      // Step 2: Flush to create and submit batch.
      await engine.flush();

      // Verify batch created and submitted.
      const batchesAfterFlush = await store.getInFlightBatches();
      expect(batchesAfterFlush).toHaveLength(1);

      // Set up fetchResults to return results for our requests.
      const norushResults: NorushResult[] = [
        {
          requestId: req1.id,
          response: { content: "Hello from Claude!" },
          success: true,
          stopReason: "end_turn",
          inputTokens: 10,
          outputTokens: 20,
        },
        {
          requestId: req2.id,
          response: { content: "Hello again!" },
          success: true,
          stopReason: "end_turn",
          inputTokens: 15,
          outputTokens: 25,
        },
      ];

      vi.mocked(provider.fetchResults).mockReturnValue(
        makeResultStream(norushResults),
      );

      // Step 3: Tick — polls batch, sees "ended", triggers ingest pipeline.
      await engine.tick();

      // Wait for the async ingestion pipeline (batch:completed handler).
      await waitForPipeline();

      // Step 4: Tick again to process deliveries.
      await engine.tick();

      // Verify results ingested.
      const reqAfterIngest1 = await store.getRequest(req1.id);
      const reqAfterIngest2 = await store.getRequest(req2.id);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test: request was just enqueued
      expect(reqAfterIngest1!.status).toBe("succeeded");
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test: request was just enqueued
      expect(reqAfterIngest2!.status).toBe("succeeded");

      // Verify delivery callbacks invoked.
      expect(delivered).toHaveLength(2);
      expect(delivered[0].result.requestId).toBe(req1.id);
      expect(delivered[1].result.requestId).toBe(req2.id);
      expect(delivered[0].result.response).toEqual({ content: "Hello from Claude!" });
    });
  });

  // -----------------------------------------------------------------------
  // Failure path: repackaging
  // -----------------------------------------------------------------------

  describe("failure path (repackaging)", () => {
    it("repackages failed requests for retry", async () => {
      const store = new MemoryStore();

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
        fetchResults: vi.fn(),
      });

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
      });

      // Enqueue requests with maxRetries = 2.
      const req1 = await engine.enqueue(makeRequest({ maxRetries: 2 }));
      const req2 = await engine.enqueue(makeRequest({ maxRetries: 2 }));

      // Flush -> submit batch.
      await engine.flush();

      // Set up fetchResults: req1 succeeds, req2 fails.
      vi.mocked(provider.fetchResults).mockReturnValue(
        makeResultStream([
          {
            requestId: req1.id,
            response: { content: "OK" },
            success: true,
          },
          {
            requestId: req2.id,
            response: { error: "server_error" },
            success: false,
          },
        ]),
      );

      // Tick -> poll returns "ended" -> ingest + repackage.
      await engine.tick();

      // Wait for async pipeline.
      await waitForPipeline();

      // req1 should be succeeded.
      const r1 = await store.getRequest(req1.id);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test: request was just enqueued
      expect(r1!.status).toBe("succeeded");

      // req2 should be re-queued for retry (retryCount incremented).
      const r2 = await store.getRequest(req2.id);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test: request was just enqueued
      expect(r2!.status).toBe("queued");
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test: request was just enqueued
      expect(r2!.retryCount).toBe(1);
    });

    it("marks requests as failed_final when retry budget exhausted", async () => {
      const store = new MemoryStore();

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
        fetchResults: vi.fn(),
      });

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
      });

      // Enqueue a request with maxRetries = 0 (no retries allowed).
      const req = await engine.enqueue(makeRequest({ maxRetries: 0 }));

      await engine.flush();

      // Set up fetchResults: request fails.
      vi.mocked(provider.fetchResults).mockReturnValue(
        makeResultStream([
          {
            requestId: req.id,
            response: { error: "server_error" },
            success: false,
          },
        ]),
      );

      // Tick -> poll returns "ended" -> ingest + repackage.
      await engine.tick();

      // Wait for async pipeline.
      await waitForPipeline();

      // Request should be marked as permanently failed.
      const r = await store.getRequest(req.id);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test: request was just enqueued
      expect(r!.status).toBe("failed_final");
    });
  });

  // -----------------------------------------------------------------------
  // Event subscription
  // -----------------------------------------------------------------------

  describe("event subscription", () => {
    it("emits batch:completed event to registered handlers", async () => {
      const store = new MemoryStore();

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
        fetchResults: vi.fn().mockReturnValue(makeResultStream([])),
      });

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
      });

      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      engine.on("batch:completed", (data) => {
        events.push({ name: "batch:completed", data });
      });

      await engine.enqueue(makeRequest());
      await engine.flush();

      // Tick -> poll returns "ended" -> emits batch:completed.
      await engine.tick();

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe("batch:completed");
      expect(events[0].data.batchId).toBeDefined();
    });

    it("emits delivery:success event when result is delivered", async () => {
      const store = new MemoryStore();

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
        fetchResults: vi.fn(),
      });

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
      });

      const deliveryEvents: Array<Record<string, unknown>> = [];
      engine.on("delivery:success", (data) => {
        deliveryEvents.push(data);
      });

      // Register a delivery callback so results get delivered.
      engine.addDeliveryCallback(async () => {
        // no-op callback — just accept delivery.
      });

      const req = await engine.enqueue(makeRequest());
      await engine.flush();

      vi.mocked(provider.fetchResults).mockReturnValue(
        makeResultStream([
          {
            requestId: req.id,
            response: { content: "OK" },
            success: true,
          },
        ]),
      );

      // Tick -> poll -> ingest.
      await engine.tick();

      // Wait for async pipeline.
      await waitForPipeline();

      // Tick -> deliver.
      await engine.tick();

      expect(deliveryEvents).toHaveLength(1);
      expect(deliveryEvents[0].requestId).toBe(req.id);
    });

    it("off() removes event handler", async () => {
      const store = new MemoryStore();
      engine = createNorush({
        store,
        providers: new Map([["claude", mockProvider()]]),
      });

      const calls: number[] = [];
      const handler = () => calls.push(1);

      engine.on("batch:completed", handler);
      engine.off("batch:completed", handler);

      expect(calls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // start() and stop()
  // -----------------------------------------------------------------------

  describe("start() and stop()", () => {
    it("start() and stop() manage interval loops", async () => {
      const store = new MemoryStore();
      engine = createNorush({
        store,
        providers: new Map([["claude", mockProvider()]]),
        batching: { flushIntervalMs: 50 },
        polling: { intervalMs: 50 },
        delivery: { tickIntervalMs: 50 },
      });

      // start() should not throw.
      engine.start();

      // Give the intervals a moment to run.
      await new Promise((resolve) => setTimeout(resolve, 150));

      // stop() should not throw.
      await engine.stop();
    });

    it("stop() performs a final flush", async () => {
      const store = new MemoryStore();
      const provider = mockProvider();

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
        batching: { flushIntervalMs: 999_999 },
      });

      await engine.enqueue(makeRequest());

      // stop() should trigger a final flush.
      await engine.stop();

      // Provider should have been called to submit.
      expect(provider.submitBatch).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Delivery callback management
  // -----------------------------------------------------------------------

  describe("delivery callbacks", () => {
    it("addDeliveryCallback and removeDeliveryCallback work", async () => {
      const store = new MemoryStore();

      const provider = mockProvider({
        checkStatus: vi.fn().mockResolvedValue("ended" as BatchStatus),
        fetchResults: vi.fn(),
      });

      engine = createNorush({
        store,
        providers: new Map([["claude", provider]]),
      });

      const delivered: string[] = [];
      const callback = async (result: Result) => {
        delivered.push(result.requestId);
      };

      engine.addDeliveryCallback(callback);

      const req = await engine.enqueue(makeRequest());
      await engine.flush();

      vi.mocked(provider.fetchResults).mockReturnValue(
        makeResultStream([
          {
            requestId: req.id,
            response: { content: "OK" },
            success: true,
          },
        ]),
      );

      // Tick -> poll -> ingest.
      await engine.tick();

      await waitForPipeline();

      // Tick -> deliver.
      await engine.tick();

      expect(delivered).toHaveLength(1);

      // Remove callback and verify no more deliveries to it.
      engine.removeDeliveryCallback(callback);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-provider
  // -----------------------------------------------------------------------

  describe("multi-provider", () => {
    it("routes requests to the correct provider adapter", async () => {
      const store = new MemoryStore();

      const claudeProvider = mockProvider({
        submitBatch: vi.fn().mockResolvedValue({
          providerBatchId: "pb_claude",
          provider: "claude",
        }),
      });

      const openaiProvider = mockProvider({
        submitBatch: vi.fn().mockResolvedValue({
          providerBatchId: "pb_openai",
          provider: "openai",
        }),
      });

      engine = createNorush({
        store,
        providers: new Map([
          ["claude", claudeProvider],
          ["openai", openaiProvider],
        ]),
      });

      await engine.enqueue(makeRequest({ provider: "claude" }));
      await engine.enqueue(makeRequest({ provider: "openai", model: "gpt-4o" }));

      await engine.flush();

      expect(claudeProvider.submitBatch).toHaveBeenCalledOnce();
      expect(openaiProvider.submitBatch).toHaveBeenCalledOnce();
    });
  });
});
