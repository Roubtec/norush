import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NorushRequest, NorushResult, ProviderBatchRef } from '../../types.js';
import { OpenAIBatchAdapter } from '../../providers/openai-batch.js';

// ---------------------------------------------------------------------------
// Mock the OpenAI SDK
// ---------------------------------------------------------------------------

const mockFilesCreate = vi.fn();
const mockFilesContent = vi.fn();
const mockBatchesCreate = vi.fn();
const mockBatchesRetrieve = vi.fn();
const mockBatchesCancel = vi.fn();

const mockToFile = vi.fn().mockImplementation(async (blob: Blob, name: string) => {
  return { blob, name };
});

vi.mock('openai', () => ({
  default: vi.fn(),
  toFile: vi.fn(),
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
    providerBatchId: 'batch_01XYZ',
    provider: 'openai',
    ...overrides,
  };
}

/**
 * Build a mock Response object that returns JSONL text content.
 */
function mockFileResponse(lines: unknown[]): { text: () => Promise<string> } {
  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n');
  return { text: async () => jsonl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIBatchAdapter', () => {
  let adapter: OpenAIBatchAdapter;

  beforeEach(async () => {
    mockFilesCreate.mockReset();
    mockFilesContent.mockReset();
    mockBatchesCreate.mockReset();
    mockBatchesRetrieve.mockReset();
    mockBatchesCancel.mockReset();
    mockToFile.mockReset();
    mockToFile.mockImplementation(async (blob: Blob, name: string) => {
      return { blob, name };
    });

    // Re-apply mock implementations before each test
    const openaiModule = await import('openai');
    (openaiModule.default as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      files: {
        create: mockFilesCreate,
        content: mockFilesContent,
      },
      batches: {
        create: mockBatchesCreate,
        retrieve: mockBatchesRetrieve,
        cancel: mockBatchesCancel,
      },
    }));
    (openaiModule.toFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockToFile);

    adapter = new OpenAIBatchAdapter({ apiKey: 'sk-test-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // submitBatch
  // -------------------------------------------------------------------------

  describe('submitBatch', () => {
    it('uploads JSONL file and creates a batch', async () => {
      mockFilesCreate.mockResolvedValue({ id: 'file-abc123' });
      mockBatchesCreate.mockResolvedValue({ id: 'batch_01XYZ' });

      const requests = [
        makeRequest({ id: 'req_001' }),
        makeRequest({ id: 'req_002', model: 'gpt-4o-mini' }),
      ];

      const ref = await adapter.submitBatch(requests);

      expect(ref).toEqual({
        providerBatchId: 'batch_01XYZ',
        provider: 'openai',
      });

      // File upload
      expect(mockFilesCreate).toHaveBeenCalledOnce();
      const fileArg = mockFilesCreate.mock.calls[0][0];
      expect(fileArg.purpose).toBe('batch');

      // Batch creation
      expect(mockBatchesCreate).toHaveBeenCalledOnce();
      const batchArg = mockBatchesCreate.mock.calls[0][0];
      expect(batchArg.input_file_id).toBe('file-abc123');
      expect(batchArg.endpoint).toBe('/v1/chat/completions');
      expect(batchArg.completion_window).toBe('24h');
    });

    it('builds correct JSONL format with custom_id as norush id', async () => {
      mockFilesCreate.mockResolvedValue({ id: 'file-xyz' });
      mockBatchesCreate.mockResolvedValue({ id: 'batch_002' });

      const req = makeRequest({
        id: 'my_norush_id',
        model: 'gpt-4o',
        params: {
          messages: [{ role: 'user', content: 'test' }],
          temperature: 0.7,
        },
      });

      await adapter.submitBatch([req]);

      // mockToFile receives the Blob as first argument
      expect(mockToFile).toHaveBeenCalledOnce();
      const blob = mockToFile.mock.calls[0][0] as Blob;
      const text = await blob.text();
      const parsed = JSON.parse(text);

      expect(parsed.custom_id).toBe('my_norush_id');
      expect(parsed.method).toBe('POST');
      expect(parsed.url).toBe('/v1/chat/completions');
      expect(parsed.body.model).toBe('gpt-4o');
      expect(parsed.body.messages).toEqual([{ role: 'user', content: 'test' }]);
      expect(parsed.body.temperature).toBe(0.7);
    });

    it('uses custom endpoint when configured', async () => {
      const customAdapter = new OpenAIBatchAdapter({
        apiKey: 'sk-test',
        endpoint: '/v1/responses',
      });

      mockFilesCreate.mockResolvedValue({ id: 'file-ep' });
      mockBatchesCreate.mockResolvedValue({ id: 'batch_ep' });

      await customAdapter.submitBatch([makeRequest()]);

      // Check the JSONL content for the correct endpoint
      expect(mockToFile).toHaveBeenCalledOnce();
      const blob = mockToFile.mock.calls[0][0] as Blob;
      const text = await blob.text();
      const parsed = JSON.parse(text);
      expect(parsed.url).toBe('/v1/responses');

      const batchArg = mockBatchesCreate.mock.calls[0][0];
      expect(batchArg.endpoint).toBe('/v1/responses');
    });

    it('propagates SDK errors on file upload', async () => {
      mockFilesCreate.mockRejectedValue(new Error('File upload failed'));

      await expect(adapter.submitBatch([makeRequest()])).rejects.toThrow('File upload failed');
    });

    it('propagates SDK errors on batch creation', async () => {
      mockFilesCreate.mockResolvedValue({ id: 'file-ok' });
      mockBatchesCreate.mockRejectedValue(new Error('Batch creation failed'));

      await expect(adapter.submitBatch([makeRequest()])).rejects.toThrow('Batch creation failed');
    });

    it('req.model takes precedence over model key in params', async () => {
      mockFilesCreate.mockResolvedValue({ id: 'file-model' });
      mockBatchesCreate.mockResolvedValue({ id: 'batch_model' });

      const req = makeRequest({
        model: 'gpt-4o',
        params: {
          model: 'should-be-ignored',
          messages: [{ role: 'user', content: 'test' }],
        },
      });
      await adapter.submitBatch([req]);

      const blob = mockToFile.mock.calls[0][0] as Blob;
      const text = await blob.text();
      const parsed = JSON.parse(text);
      expect(parsed.body.model).toBe('gpt-4o');
    });
  });

  // -------------------------------------------------------------------------
  // checkStatus
  // -------------------------------------------------------------------------

  describe('checkStatus', () => {
    it("maps 'validating' to 'processing'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'validating' });
      expect(await adapter.checkStatus(makeRef())).toBe('processing');
    });

    it("maps 'in_progress' to 'processing'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'in_progress' });
      expect(await adapter.checkStatus(makeRef())).toBe('processing');
    });

    it("maps 'finalizing' to 'processing'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'finalizing' });
      expect(await adapter.checkStatus(makeRef())).toBe('processing');
    });

    it("maps 'cancelling' to 'processing'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'cancelling' });
      expect(await adapter.checkStatus(makeRef())).toBe('processing');
    });

    it("maps 'completed' to 'ended'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'completed' });
      expect(await adapter.checkStatus(makeRef())).toBe('ended');
    });

    it("maps 'expired' to 'expired'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'expired' });
      expect(await adapter.checkStatus(makeRef())).toBe('expired');
    });

    it("maps 'cancelled' to 'cancelled'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'cancelled' });
      expect(await adapter.checkStatus(makeRef())).toBe('cancelled');
    });

    it("maps 'failed' to 'failed'", async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'failed' });
      expect(await adapter.checkStatus(makeRef())).toBe('failed');
    });

    it('calls retrieve with the correct batch ID', async () => {
      mockBatchesRetrieve.mockResolvedValue({ status: 'in_progress' });

      await adapter.checkStatus(makeRef({ providerBatchId: 'batch_ABC' }));

      expect(mockBatchesRetrieve).toHaveBeenCalledWith('batch_ABC');
    });
  });

  // -------------------------------------------------------------------------
  // fetchResults
  // -------------------------------------------------------------------------

  describe('fetchResults', () => {
    it('yields NorushResult for successful chat completion results', async () => {
      mockBatchesRetrieve.mockResolvedValue({
        status: 'completed',
        output_file_id: 'file-out-001',
        error_file_id: undefined,
      });

      mockFilesContent.mockResolvedValue(
        mockFileResponse([
          {
            id: 'resp_001',
            custom_id: 'req_001',
            response: {
              status_code: 200,
              body: {
                id: 'chatcmpl-abc',
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
              },
            },
            error: null,
          },
        ]),
      );

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe('req_001');
      expect(results[0].success).toBe(true);
      expect(results[0].stopReason).toBe('stop');
      expect(results[0].inputTokens).toBe(10);
      expect(results[0].outputTokens).toBe(5);
      expect(results[0].response).toMatchObject({
        model: 'gpt-4o',
        choices: expect.arrayContaining([
          expect.objectContaining({
            message: { role: 'assistant', content: 'Hello!' },
          }),
        ]),
      });
    });

    it('yields NorushResult for error responses (HTTP 4xx/5xx)', async () => {
      mockBatchesRetrieve.mockResolvedValue({
        status: 'completed',
        output_file_id: 'file-out-002',
        error_file_id: undefined,
      });

      mockFilesContent.mockResolvedValue(
        mockFileResponse([
          {
            id: 'resp_002',
            custom_id: 'req_002',
            response: {
              status_code: 429,
              body: {
                error: {
                  message: 'Rate limit exceeded',
                  type: 'rate_limit_error',
                },
              },
            },
            error: null,
          },
        ]),
      );

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe('req_002');
      expect(results[0].success).toBe(false);
      expect(results[0].inputTokens).toBeNull();
    });

    it('yields NorushResult for error field errors', async () => {
      mockBatchesRetrieve.mockResolvedValue({
        status: 'completed',
        output_file_id: undefined,
        error_file_id: 'file-err-001',
      });

      mockFilesContent.mockResolvedValue(
        mockFileResponse([
          {
            id: 'resp_003',
            custom_id: 'req_003',
            response: null,
            error: {
              code: 'server_error',
              message: 'Internal server error',
            },
          },
        ]),
      );

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe('req_003');
      expect(results[0].success).toBe(false);
      expect(results[0].response).toMatchObject({
        code: 'server_error',
        message: 'Internal server error',
      });
    });

    it('yields from both output file and error file', async () => {
      mockBatchesRetrieve.mockResolvedValue({
        status: 'completed',
        output_file_id: 'file-out-both',
        error_file_id: 'file-err-both',
      });

      // Output file: 1 success
      mockFilesContent.mockResolvedValueOnce(
        mockFileResponse([
          {
            id: 'resp_s1',
            custom_id: 'req_success',
            response: {
              status_code: 200,
              body: {
                id: 'chatcmpl-s1',
                choices: [{ finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 3 },
              },
            },
            error: null,
          },
        ]),
      );

      // Error file: 1 failure
      mockFilesContent.mockResolvedValueOnce(
        mockFileResponse([
          {
            id: 'resp_f1',
            custom_id: 'req_failure',
            response: null,
            error: { code: 'context_length_exceeded', message: 'Too long' },
          },
        ]),
      );

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(2);
      expect(results[0].requestId).toBe('req_success');
      expect(results[0].success).toBe(true);
      expect(results[1].requestId).toBe('req_failure');
      expect(results[1].success).toBe(false);
    });

    it('handles batch with no output files (e.g. all cancelled)', async () => {
      mockBatchesRetrieve.mockResolvedValue({
        status: 'cancelled',
        output_file_id: undefined,
        error_file_id: undefined,
      });

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(0);
      expect(mockFilesContent).not.toHaveBeenCalled();
    });

    it('handles empty lines in JSONL output gracefully', async () => {
      mockBatchesRetrieve.mockResolvedValue({
        status: 'completed',
        output_file_id: 'file-empty-lines',
        error_file_id: undefined,
      });

      // Simulate JSONL with empty lines
      const jsonlWithEmptyLines =
        JSON.stringify({
          id: 'resp_1',
          custom_id: 'req_1',
          response: {
            status_code: 200,
            body: {
              choices: [{ finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          },
          error: null,
        }) +
        '\n\n' +
        JSON.stringify({
          id: 'resp_2',
          custom_id: 'req_2',
          response: {
            status_code: 200,
            body: {
              choices: [{ finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 2 },
            },
          },
          error: null,
        }) +
        '\n';

      mockFilesContent.mockResolvedValue({
        text: async () => jsonlWithEmptyLines,
      });

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results).toHaveLength(2);
    });

    it('custom_id round-trips correctly through submission and results', async () => {
      const originalId = '01HWXYZ_special-chars-123';

      // Submit
      mockFilesCreate.mockResolvedValue({ id: 'file-rt' });
      mockBatchesCreate.mockResolvedValue({ id: 'batch_rt' });
      await adapter.submitBatch([makeRequest({ id: originalId })]);

      // Verify the JSONL contains the original ID
      const toFileCall = mockToFile.mock.calls[0];
      const blob = toFileCall[0] as Blob;
      const jsonlText = await blob.text();
      const parsed = JSON.parse(jsonlText);
      expect(parsed.custom_id).toBe(originalId);

      // Fetch results
      mockBatchesRetrieve.mockResolvedValue({
        status: 'completed',
        output_file_id: 'file-rt-out',
        error_file_id: undefined,
      });
      mockFilesContent.mockResolvedValue(
        mockFileResponse([
          {
            id: 'resp_rt',
            custom_id: originalId,
            response: {
              status_code: 200,
              body: {
                choices: [{ finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              },
            },
            error: null,
          },
        ]),
      );

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results[0].requestId).toBe(originalId);
    });

    it('extracts usage from responses without usage field', async () => {
      mockBatchesRetrieve.mockResolvedValue({
        status: 'completed',
        output_file_id: 'file-no-usage',
        error_file_id: undefined,
      });

      mockFilesContent.mockResolvedValue(
        mockFileResponse([
          {
            id: 'resp_nu',
            custom_id: 'req_nu',
            response: {
              status_code: 200,
              body: {
                choices: [{ finish_reason: 'length' }],
                // No usage field
              },
            },
            error: null,
          },
        ]),
      );

      const results: NorushResult[] = [];
      for await (const r of adapter.fetchResults(makeRef())) {
        results.push(r);
      }

      expect(results[0].inputTokens).toBeNull();
      expect(results[0].outputTokens).toBeNull();
      expect(results[0].stopReason).toBe('length');
    });
  });

  // -------------------------------------------------------------------------
  // cancelBatch
  // -------------------------------------------------------------------------

  describe('cancelBatch', () => {
    it('calls cancel with the correct batch ID', async () => {
      mockBatchesCancel.mockResolvedValue({
        id: 'batch_cancel_01',
        status: 'cancelling',
      });

      await adapter.cancelBatch(makeRef({ providerBatchId: 'batch_cancel_01' }));

      expect(mockBatchesCancel).toHaveBeenCalledWith('batch_cancel_01');
    });

    it('propagates SDK errors on cancel', async () => {
      mockBatchesCancel.mockRejectedValue(new Error('Batch not found'));

      await expect(
        adapter.cancelBatch(makeRef({ providerBatchId: 'nonexistent' })),
      ).rejects.toThrow('Batch not found');
    });
  });
});
