import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NorushRequest, ProviderBatchRef } from "../../types.js";
import { ClaudeAdapter } from "../../providers/claude.js";

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK
// ---------------------------------------------------------------------------

// We mock at the module level so every `new Anthropic(...)` returns our mock.
const mockBatchesCreate = vi.fn();
const mockBatchesRetrieve = vi.fn();
const mockBatchesResults = vi.fn();
const mockBatchesCancel = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<NorushRequest> = {}): NorushRequest {
  return {
    id: "req_01ABC",
    externalId: "ext_01ABC",
    provider: "claude",
    model: "claude-sonnet-4-5-20250929",
    params: {
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello, world" }],
    },
    ...overrides,
  };
}

function makeRef(overrides: Partial<ProviderBatchRef> = {}): ProviderBatchRef {
  return {
    providerBatchId: "msgbatch_01XYZ",
    provider: "claude",
    ...overrides,
  };
}

/** Helper to create an async iterable from an array. */
async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeAdapter", () => {
  let adapter: ClaudeAdapter;

  beforeEach(async () => {
    mockBatchesCreate.mockReset();
    mockBatchesRetrieve.mockReset();
    mockBatchesResults.mockReset();
    mockBatchesCancel.mockReset();

    // Re-apply the mock implementation before each test
    const { default: MockAnthropic } = await import("@anthropic-ai/sdk");
    (MockAnthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({
        messages: {
          batches: {
            create: mockBatchesCreate,
            retrieve: mockBatchesRetrieve,
            results: mockBatchesResults,
            cancel: mockBatchesCancel,
          },
        },
      }),
    );

    adapter = new ClaudeAdapter({ apiKey: "sk-test-key" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // submitBatch
  // -------------------------------------------------------------------------

  describe("submitBatch", () => {
    it("submits requests and returns a ProviderBatchRef", async () => {
      mockBatchesCreate.mockResolvedValue({
        id: "msgbatch_01XYZ",
        processing_status: "in_progress",
      });

      const requests = [
        makeRequest({ id: "req_001" }),
        makeRequest({ id: "req_002", model: "claude-opus-4-6" }),
      ];

      const ref = await adapter.submitBatch(requests);

      expect(ref).toEqual({
        providerBatchId: "msgbatch_01XYZ",
        provider: "claude",
      });

      expect(mockBatchesCreate).toHaveBeenCalledOnce();
      const createArg = mockBatchesCreate.mock.calls[0][0];
      expect(createArg.requests).toHaveLength(2);
      expect(createArg.requests[0].custom_id).toBe("req_001");
      expect(createArg.requests[1].custom_id).toBe("req_002");
      expect(createArg.requests[1].params.model).toBe("claude-opus-4-6");
    });

    it("uses norush request id as custom_id for round-trip mapping", async () => {
      mockBatchesCreate.mockResolvedValue({ id: "msgbatch_002" });

      const req = makeRequest({ id: "my_unique_id_123" });
      await adapter.submitBatch([req]);

      const createArg = mockBatchesCreate.mock.calls[0][0];
      expect(createArg.requests[0].custom_id).toBe("my_unique_id_123");
    });

    it("defaults max_tokens to 4096 when not provided in params", async () => {
      mockBatchesCreate.mockResolvedValue({ id: "msgbatch_003" });

      const req = makeRequest({
        params: {
          messages: [{ role: "user", content: "test" }],
        },
      });
      await adapter.submitBatch([req]);

      const createArg = mockBatchesCreate.mock.calls[0][0];
      expect(createArg.requests[0].params.max_tokens).toBe(4096);
    });

    it("preserves explicit max_tokens from params", async () => {
      mockBatchesCreate.mockResolvedValue({ id: "msgbatch_004" });

      const req = makeRequest({
        params: {
          max_tokens: 2048,
          messages: [{ role: "user", content: "test" }],
        },
      });
      await adapter.submitBatch([req]);

      const createArg = mockBatchesCreate.mock.calls[0][0];
      expect(createArg.requests[0].params.max_tokens).toBe(2048);
    });

    it("req.model takes precedence over model key in params", async () => {
      mockBatchesCreate.mockResolvedValue({ id: "msgbatch_005" });

      const req = makeRequest({
        model: "claude-sonnet-4-5-20250929",
        params: {
          model: "should-be-ignored",
          max_tokens: 1024,
          messages: [{ role: "user", content: "test" }],
        },
      });
      await adapter.submitBatch([req]);

      const createArg = mockBatchesCreate.mock.calls[0][0];
      expect(createArg.requests[0].params.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("throws when messages is missing from params", async () => {
      const req = makeRequest({ params: { max_tokens: 1024 } });

      await expect(adapter.submitBatch([req])).rejects.toThrow(
        /must include a "messages" array/,
      );
      expect(mockBatchesCreate).not.toHaveBeenCalled();
    });

    it("throws when messages is not an array", async () => {
      const req = makeRequest({
        params: { max_tokens: 1024, messages: "not-an-array" },
      });

      await expect(adapter.submitBatch([req])).rejects.toThrow(
        /must include a "messages" array/,
      );
    });

    it("throws when max_tokens is present but not a number", async () => {
      const req = makeRequest({
        params: {
          max_tokens: "2048",
          messages: [{ role: "user", content: "test" }],
        },
      });

      await expect(adapter.submitBatch([req])).rejects.toThrow(
        /invalid "max_tokens"/,
      );
      expect(mockBatchesCreate).not.toHaveBeenCalled();
    });

    it("propagates SDK errors", async () => {
      mockBatchesCreate.mockRejectedValue(
        new Error("API rate limit exceeded"),
      );

      await expect(adapter.submitBatch([makeRequest()])).rejects.toThrow(
        "API rate limit exceeded",
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkStatus
  // -------------------------------------------------------------------------

  describe("checkStatus", () => {
    it("maps 'in_progress' to 'processing'", async () => {
      mockBatchesRetrieve.mockResolvedValue({
        processing_status: "in_progress",
      });
      expect(await adapter.checkStatus(makeRef())).toBe("processing");
    });

    it("maps 'canceling' to 'processing'", async () => {
      mockBatchesRetrieve.mockResolvedValue({
        processing_status: "canceling",
      });
      expect(await adapter.checkStatus(makeRef())).toBe("processing");
    });

    it("maps 'ended' to 'ended'", async () => {
      mockBatchesRetrieve.mockResolvedValue({
        processing_status: "ended",
      });
      expect(await adapter.checkStatus(makeRef())).toBe("ended");
    });

    it("calls retrieve with the correct batch ID", async () => {
      mockBatchesRetrieve.mockResolvedValue({
        processing_status: "in_progress",
      });

      await adapter.checkStatus(makeRef({ providerBatchId: "batch_ABC" }));

      expect(mockBatchesRetrieve).toHaveBeenCalledWith("batch_ABC");
    });
  });

  // -------------------------------------------------------------------------
  // fetchResults
  // -------------------------------------------------------------------------

  describe("fetchResults", () => {
    it("yields NorushResult for succeeded results", async () => {
      mockBatchesResults.mockResolvedValue(
        asyncIter([
          {
            custom_id: "req_001",
            result: {
              type: "succeeded",
              message: {
                id: "msg_123",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Hello!" }],
                model: "claude-sonnet-4-5-20250929",
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                },
              },
            },
          },
        ]),
      );

      const results: import("../../types.js").NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe("req_001");
      expect(results[0].success).toBe(true);
      expect(results[0].stopReason).toBe("end_turn");
      expect(results[0].inputTokens).toBe(10);
      expect(results[0].outputTokens).toBe(5);
      expect(results[0].response).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      });
    });

    it("yields NorushResult for errored results", async () => {
      mockBatchesResults.mockResolvedValue(
        asyncIter([
          {
            custom_id: "req_002",
            result: {
              type: "errored",
              error: {
                type: "error",
                error: {
                  type: "overloaded_error",
                  message: "Overloaded",
                },
              },
            },
          },
        ]),
      );

      const results: import("../../types.js").NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe("req_002");
      expect(results[0].success).toBe(false);
      expect(results[0].stopReason).toBeNull();
      expect(results[0].inputTokens).toBeNull();
      expect(results[0].outputTokens).toBeNull();
    });

    it("yields NorushResult for canceled results", async () => {
      mockBatchesResults.mockResolvedValue(
        asyncIter([
          {
            custom_id: "req_003",
            result: { type: "canceled" },
          },
        ]),
      );

      const results: import("../../types.js").NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe("req_003");
      expect(results[0].success).toBe(false);
      expect(results[0].response).toEqual({ type: "canceled" });
    });

    it("yields NorushResult for expired results", async () => {
      mockBatchesResults.mockResolvedValue(
        asyncIter([
          {
            custom_id: "req_004",
            result: { type: "expired" },
          },
        ]),
      );

      const results: import("../../types.js").NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe("req_004");
      expect(results[0].success).toBe(false);
      expect(results[0].response).toEqual({ type: "expired" });
    });

    it("handles mixed result types in a single batch", async () => {
      mockBatchesResults.mockResolvedValue(
        asyncIter([
          {
            custom_id: "req_a",
            result: {
              type: "succeeded",
              message: {
                id: "msg_a",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "OK" }],
                model: "claude-sonnet-4-5-20250929",
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 2 },
              },
            },
          },
          {
            custom_id: "req_b",
            result: { type: "expired" },
          },
          {
            custom_id: "req_c",
            result: {
              type: "errored",
              error: {
                type: "error",
                error: { type: "api_error", message: "Internal error" },
              },
            },
          },
        ]),
      );

      const results: import("../../types.js").NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[0].requestId).toBe("req_a");
      expect(results[1].success).toBe(false);
      expect(results[1].requestId).toBe("req_b");
      expect(results[2].success).toBe(false);
      expect(results[2].requestId).toBe("req_c");
    });

    it("custom_id round-trips correctly", async () => {
      const originalId = "01HWXYZ_special-chars-123";

      mockBatchesCreate.mockResolvedValue({ id: "msgbatch_rt" });
      await adapter.submitBatch([makeRequest({ id: originalId })]);

      // Verify the custom_id was sent
      const createArg = mockBatchesCreate.mock.calls[0][0];
      expect(createArg.requests[0].custom_id).toBe(originalId);

      // Verify it comes back in results
      mockBatchesResults.mockResolvedValue(
        asyncIter([
          {
            custom_id: originalId,
            result: {
              type: "succeeded",
              message: {
                id: "msg_rt",
                type: "message",
                role: "assistant",
                content: [],
                model: "claude-sonnet-4-5-20250929",
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          },
        ]),
      );

      const results: import("../../types.js").NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results[0].requestId).toBe(originalId);
    });
  });

  // -------------------------------------------------------------------------
  // cancelBatch
  // -------------------------------------------------------------------------

  describe("cancelBatch", () => {
    it("calls cancel with the correct batch ID", async () => {
      mockBatchesCancel.mockResolvedValue({
        id: "msgbatch_cancel_01",
        processing_status: "canceling",
      });

      await adapter.cancelBatch(
        makeRef({ providerBatchId: "msgbatch_cancel_01" }),
      );

      expect(mockBatchesCancel).toHaveBeenCalledWith("msgbatch_cancel_01");
    });

    it("propagates SDK errors on cancel", async () => {
      mockBatchesCancel.mockRejectedValue(
        new Error("Batch not found"),
      );

      await expect(
        adapter.cancelBatch(makeRef({ providerBatchId: "nonexistent" })),
      ).rejects.toThrow("Batch not found");
    });
  });
});
