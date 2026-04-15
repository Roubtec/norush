import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NorushRequest, NorushResult, ProviderBatchRef } from '../../types.js';
import { OpenAIFlexAdapter } from '../../providers/openai-flex.js';

// ---------------------------------------------------------------------------
// Mock the OpenAI SDK
// ---------------------------------------------------------------------------

const mockChatCompletionsCreate = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<NorushRequest> = {}): NorushRequest {
  return {
    id: 'req_01ABC',
    externalId: 'ext_01ABC',
    provider: 'openai',
    model: 'gpt-4o',
    params: {
      messages: [{ role: 'user', content: 'Hello, world' }],
    },
    ...overrides,
  };
}

function makeRef(overrides: Partial<ProviderBatchRef> = {}): ProviderBatchRef {
  return {
    providerBatchId: 'flex_1_1700000000000',
    provider: 'openai',
    ...overrides,
  };
}

/**
 * Build a mock chat completion response.
 */
function mockCompletionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    service_tier: 'flex',
    ...overrides,
  };
}

/**
 * Create a mock 429 error similar to what the OpenAI SDK throws.
 */
function make429Error(message = 'Resource temporarily unavailable') {
  const err = new Error(message) as Error & { status: number };
  err.status = 429;
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIFlexAdapter', () => {
  let adapter: OpenAIFlexAdapter;
  let sleepMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockChatCompletionsCreate.mockReset();

    // Re-apply mock implementations before each test
    const openaiModule = await import('openai');
    (openaiModule.default as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_opts: Record<string, unknown>) => ({
        chat: {
          completions: {
            create: mockChatCompletionsCreate,
          },
        },
      }),
    );

    sleepMock = vi.fn().mockResolvedValue(undefined);
    adapter = new OpenAIFlexAdapter({ apiKey: 'sk-test-key', sleep: sleepMock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / SDK configuration
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('passes 15-minute timeout to the SDK by default', async () => {
      const openaiModule = await import('openai');
      const MockOpenAI = openaiModule.default as unknown as ReturnType<typeof vi.fn>;
      MockOpenAI.mockClear();

      new OpenAIFlexAdapter({ apiKey: 'sk-test' });

      expect(MockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ timeout: 900_000 }));
    });

    it('allows custom timeout override', async () => {
      const openaiModule = await import('openai');
      const MockOpenAI = openaiModule.default as unknown as ReturnType<typeof vi.fn>;
      MockOpenAI.mockClear();

      new OpenAIFlexAdapter({ apiKey: 'sk-test', timeoutMs: 60_000 });

      expect(MockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ timeout: 60_000 }));
    });

    it('passes baseURL to the SDK when provided', async () => {
      const openaiModule = await import('openai');
      const MockOpenAI = openaiModule.default as unknown as ReturnType<typeof vi.fn>;
      MockOpenAI.mockClear();

      new OpenAIFlexAdapter({
        apiKey: 'sk-test',
        baseURL: 'https://custom.proxy.dev',
      });

      expect(MockOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://custom.proxy.dev' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // submitBatch
  // -------------------------------------------------------------------------

  describe('submitBatch', () => {
    it('sends request with service_tier flex', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      await adapter.submitBatch([makeRequest()]);

      expect(mockChatCompletionsCreate).toHaveBeenCalledOnce();
      const callArg = mockChatCompletionsCreate.mock.calls[0][0];
      expect(callArg.service_tier).toBe('flex');
    });

    it('forces stream: false even if params contains stream: true', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const req = makeRequest({
        params: {
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
        },
      });
      await adapter.submitBatch([req]);

      const callArg = mockChatCompletionsCreate.mock.calls[0][0];
      expect(callArg.stream).toBe(false);
    });

    it('includes model from request, overriding params.model', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const req = makeRequest({
        model: 'gpt-4o',
        params: {
          model: 'should-be-ignored',
          messages: [{ role: 'user', content: 'test' }],
        },
      });
      await adapter.submitBatch([req]);

      const callArg = mockChatCompletionsCreate.mock.calls[0][0];
      expect(callArg.model).toBe('gpt-4o');
    });

    it('passes through all params to the SDK', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const req = makeRequest({
        params: {
          messages: [{ role: 'user', content: 'test' }],
          temperature: 0.7,
          max_tokens: 100,
        },
      });
      await adapter.submitBatch([req]);

      const callArg = mockChatCompletionsCreate.mock.calls[0][0];
      expect(callArg.temperature).toBe(0.7);
      expect(callArg.max_tokens).toBe(100);
      expect(callArg.messages).toEqual([{ role: 'user', content: 'test' }]);
    });

    it("returns a ProviderBatchRef with provider 'openai'", async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const ref = await adapter.submitBatch([makeRequest()]);

      expect(ref.provider).toBe('openai');
      expect(ref.providerBatchId).toMatch(/^flex_/);
    });

    it('processes multiple requests serially', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const requests = [
        makeRequest({ id: 'req_001' }),
        makeRequest({ id: 'req_002' }),
        makeRequest({ id: 'req_003' }),
      ];

      const ref = await adapter.submitBatch(requests);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.requestId)).toEqual(['req_001', 'req_002', 'req_003']);
    });

    it('returns error result for non-429 SDK errors', async () => {
      mockChatCompletionsCreate.mockRejectedValue(new Error('Invalid API key'));

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].response).toEqual({ error: 'Invalid API key' });
      expect(results[0].stopReason).toBeNull();
      expect(results[0].inputTokens).toBeNull();
      expect(results[0].outputTokens).toBeNull();
    });

    it('extracts usage from successful response', async () => {
      mockChatCompletionsCreate.mockResolvedValue(
        mockCompletionResponse({
          usage: {
            prompt_tokens: 42,
            completion_tokens: 17,
            total_tokens: 59,
          },
        }),
      );

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(results[0].inputTokens).toBe(42);
      expect(results[0].outputTokens).toBe(17);
    });

    it('extracts stop reason from successful response', async () => {
      mockChatCompletionsCreate.mockResolvedValue(
        mockCompletionResponse({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '...' },
              finish_reason: 'length',
            },
          ],
        }),
      );

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(results[0].stopReason).toBe('length');
    });

    it('handles response without usage field', async () => {
      const response = mockCompletionResponse();
      delete (response as Record<string, unknown>).usage;
      mockChatCompletionsCreate.mockResolvedValue(response);

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(results[0].inputTokens).toBeNull();
      expect(results[0].outputTokens).toBeNull();
    });

    it('handles mix of successful and failed requests in a batch', async () => {
      mockChatCompletionsCreate
        .mockResolvedValueOnce(mockCompletionResponse())
        .mockRejectedValueOnce(new Error('Server error'))
        .mockResolvedValueOnce(mockCompletionResponse());

      const requests = [
        makeRequest({ id: 'req_ok_1' }),
        makeRequest({ id: 'req_fail' }),
        makeRequest({ id: 'req_ok_2' }),
      ];

      const ref = await adapter.submitBatch(requests);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[0].requestId).toBe('req_ok_1');
      expect(results[1].success).toBe(false);
      expect(results[1].requestId).toBe('req_fail');
      expect(results[2].success).toBe(true);
      expect(results[2].requestId).toBe('req_ok_2');
    });
  });

  // -------------------------------------------------------------------------
  // 429 Retry with backoff
  // -------------------------------------------------------------------------

  describe('429 retry with backoff', () => {
    it('retries on 429 and succeeds on subsequent attempt', async () => {
      mockChatCompletionsCreate
        .mockRejectedValueOnce(make429Error())
        .mockResolvedValueOnce(mockCompletionResponse());

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(2);
      expect(results[0].success).toBe(true);
      expect(sleepMock).toHaveBeenCalledOnce();
    });

    it('uses exponential backoff delays with ±5% jitter', async () => {
      mockChatCompletionsCreate
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockRejectedValueOnce(make429Error())
        .mockResolvedValueOnce(mockCompletionResponse());

      // Use custom base delay for predictable assertions
      const customSleepMock = vi.fn().mockResolvedValue(undefined);
      const customAdapter = new OpenAIFlexAdapter({
        apiKey: 'sk-test',
        baseDelayMs: 100,
        sleep: customSleepMock,
      });

      const ref = await customAdapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of customAdapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(customSleepMock).toHaveBeenCalledTimes(3);
      // Exponential with 98–105% jitter applied to base * 2^attempt
      // attempt 0: 100 * [0.98, 1.05) → [98, 105]
      // attempt 1: 200 * [0.98, 1.05) → [196, 210]
      // attempt 2: 400 * [0.98, 1.05) → [392, 420]
      const [delay0] = customSleepMock.mock.calls[0] as [number];
      const [delay1] = customSleepMock.mock.calls[1] as [number];
      const [delay2] = customSleepMock.mock.calls[2] as [number];
      expect(delay0).toBeGreaterThanOrEqual(98);
      expect(delay0).toBeLessThanOrEqual(105);
      expect(delay1).toBeGreaterThanOrEqual(196);
      expect(delay1).toBeLessThanOrEqual(210);
      expect(delay2).toBeGreaterThanOrEqual(392);
      expect(delay2).toBeLessThanOrEqual(420);

      expect(results[0].success).toBe(true);
    });

    it('returns error after exhausting max retries on 429', async () => {
      // Default max retries is 5, so need 6 failures total (initial + 5 retries)
      for (let i = 0; i < 6; i++) {
        mockChatCompletionsCreate.mockRejectedValueOnce(make429Error());
      }

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      // Initial attempt + 5 retries = 6
      expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(6);
      expect(results[0].success).toBe(false);
      expect(results[0].response).toEqual({
        error: 'Resource temporarily unavailable',
      });
    });

    it('respects custom maxRetries setting', async () => {
      const customAdapter = new OpenAIFlexAdapter({
        apiKey: 'sk-test',
        maxRetries: 2,
        sleep: vi.fn().mockResolvedValue(undefined),
      });

      // 3 failures total (initial + 2 retries)
      for (let i = 0; i < 3; i++) {
        mockChatCompletionsCreate.mockRejectedValueOnce(make429Error());
      }

      const ref = await customAdapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of customAdapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(3);
      expect(results[0].success).toBe(false);
    });

    it('does not retry on non-429 errors', async () => {
      const err = new Error('Bad request') as Error & { status: number };
      err.status = 400;
      mockChatCompletionsCreate.mockRejectedValue(err);

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(mockChatCompletionsCreate).toHaveBeenCalledOnce();
      expect(results[0].success).toBe(false);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('does not retry on plain Error without status', async () => {
      mockChatCompletionsCreate.mockRejectedValue(new Error('Network timeout'));

      const ref = await adapter.submitBatch([makeRequest()]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(mockChatCompletionsCreate).toHaveBeenCalledOnce();
      expect(sleepMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // checkStatus
  // -------------------------------------------------------------------------

  describe('checkStatus', () => {
    it("returns 'ended' when results are in cache", async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());
      const ref = await adapter.submitBatch([makeRequest()]);
      const status = await adapter.checkStatus(ref);
      expect(status).toBe('ended');
    });

    it('throws when batch results are not in cache (unknown or post-restart)', async () => {
      await expect(
        adapter.checkStatus(makeRef({ providerBatchId: 'nonexistent' })),
      ).rejects.toThrow(
        'OpenAI Flex batch results are unavailable for providerBatchId: nonexistent',
      );
    });
  });

  // -------------------------------------------------------------------------
  // fetchResults
  // -------------------------------------------------------------------------

  describe('fetchResults', () => {
    it('yields results from the cache for a valid ref', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const ref = await adapter.submitBatch([makeRequest({ id: 'req_001' })]);
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe('req_001');
      expect(results[0].success).toBe(true);
      expect(results[0].response).toMatchObject({
        model: 'gpt-4o',
        service_tier: 'flex',
      });
    });

    it('yields nothing for an unknown ref', async () => {
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef({ providerBatchId: 'unknown' }))) {
        results.push(r);
      }

      expect(results).toHaveLength(0);
    });

    it('cleans up cache after yielding all results', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const ref = await adapter.submitBatch([makeRequest()]);

      // First fetch — yields results
      const firstResults: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        firstResults.push(r);
      }
      expect(firstResults).toHaveLength(1);

      // Second fetch — cache cleared, nothing returned
      const secondResults: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        secondResults.push(r);
      }
      expect(secondResults).toHaveLength(0);
    });

    it('cleans up cache even when consumer breaks out early', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const requests = [
        makeRequest({ id: 'req_001' }),
        makeRequest({ id: 'req_002' }),
        makeRequest({ id: 'req_003' }),
      ];
      const ref = await adapter.submitBatch(requests);

      // Break after first result
      for await (const _r of adapter.fetchResults(ref)) {
        break;
      }

      // Cache should be gone; subsequent checkStatus should throw
      await expect(adapter.checkStatus(ref)).rejects.toThrow(
        'OpenAI Flex batch results are unavailable',
      );
    });
  });

  // -------------------------------------------------------------------------
  // cancelBatch
  // -------------------------------------------------------------------------

  describe('cancelBatch', () => {
    it('cleans up cached results on cancel', async () => {
      mockChatCompletionsCreate.mockResolvedValue(mockCompletionResponse());

      const ref = await adapter.submitBatch([makeRequest()]);
      await adapter.cancelBatch(ref);

      // Results should be gone after cancel
      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(ref)) {
        results.push(r);
      }
      expect(results).toHaveLength(0);
    });

    it('does not throw for unknown ref', async () => {
      await expect(
        adapter.cancelBatch(makeRef({ providerBatchId: 'nonexistent' })),
      ).resolves.toBeUndefined();
    });
  });
});
