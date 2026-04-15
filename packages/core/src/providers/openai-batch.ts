/**
 * OpenAI Batch API provider adapter.
 *
 * Implements the Provider interface using the openai SDK package.
 * Follows the two-step submission flow: build JSONL, upload via Files API,
 * then create a batch referencing the uploaded file. Results are fetched
 * by downloading the output file and parsing JSONL line-by-line.
 */

import OpenAI, { toFile } from 'openai';
import type { Batch as OpenAIBatch } from 'openai/resources/batches.js';
import type { Provider } from '../interfaces/provider.js';
import type { BatchStatus, NorushRequest, NorushResult, ProviderBatchRef } from '../types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenAIBatchAdapterOptions {
  /** OpenAI API key. Passed to the SDK constructor. */
  apiKey: string;
  /** Optional base URL override (e.g. for proxies or testing). */
  baseURL?: string;
  /**
   * The OpenAI API endpoint to use for batch requests.
   * Defaults to "/v1/chat/completions".
   */
  endpoint?: '/v1/responses' | '/v1/chat/completions' | '/v1/embeddings' | '/v1/completions';
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map OpenAI batch status to norush BatchStatus.
 *
 * OpenAI statuses: validating | failed | in_progress | finalizing |
 *                  completed | expired | cancelling | cancelled
 */
function mapStatus(status: OpenAIBatch['status']): BatchStatus {
  switch (status) {
    case 'validating':
    case 'in_progress':
    case 'finalizing':
    case 'cancelling':
      return 'processing';
    case 'completed':
      return 'ended';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

/**
 * Build a single JSONL line for the OpenAI Batch API input format.
 *
 * Each line is a JSON object with:
 * - custom_id: the norush request ID
 * - method: "POST"
 * - url: the endpoint path
 * - body: the request payload
 */
function buildJsonlLine(req: NorushRequest, endpoint: string): string {
  const line = {
    custom_id: req.id,
    method: 'POST',
    url: endpoint,
    body: {
      ...req.params,
      model: req.model,
    },
  };
  return JSON.stringify(line);
}

/**
 * Build complete JSONL content from an array of requests.
 */
function buildJsonl(requests: NorushRequest[], endpoint: string): string {
  return requests.map((req) => buildJsonlLine(req, endpoint)).join('\n');
}

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

/** Shape of a single line in the OpenAI batch output JSONL. */
interface OpenAIOutputLine {
  id: string;
  custom_id: string;
  response: {
    status_code: number;
    body: Record<string, unknown>;
  } | null;
  error: {
    code: string;
    message: string;
  } | null;
}

/**
 * Extract token usage from an OpenAI chat completion response body.
 * The body shape varies by endpoint; we handle the common chat completions case.
 */
function extractUsage(body: Record<string, unknown>): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const usage = body.usage as
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    | undefined;
  if (!usage) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
  };
}

/**
 * Extract the stop/finish reason from an OpenAI response body.
 * Works for both chat completions and responses API formats.
 */
function extractStopReason(body: Record<string, unknown>): string | null {
  // Chat completions format: body.choices[0].finish_reason
  const choices = body.choices as Array<{ finish_reason?: string }> | undefined;
  if (choices?.[0]?.finish_reason) return choices[0].finish_reason;

  // Responses API format: body.status
  if (typeof body.status === 'string') return body.status;

  return null;
}

/**
 * Convert a single OpenAI output line into a NorushResult.
 */
function mapResult(line: OpenAIOutputLine): NorushResult {
  const requestId = line.custom_id;

  // Error case: either the response is null, or the error field is set,
  // or the HTTP status code indicates failure.
  if (line.error || !line.response || line.response.status_code >= 400) {
    return {
      requestId,
      response: line.error
        ? (line.error as unknown as Record<string, unknown>)
        : (line.response?.body ?? { error: 'unknown_error' }),
      success: false,
      stopReason: null,
      inputTokens: null,
      outputTokens: null,
    };
  }

  const body = line.response.body;
  const { inputTokens, outputTokens } = extractUsage(body);
  const stopReason = extractStopReason(body);

  return {
    requestId,
    response: body,
    success: true,
    stopReason,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIBatchAdapter implements Provider {
  private readonly client: OpenAI;
  private readonly endpoint: NonNullable<OpenAIBatchAdapterOptions['endpoint']>;

  constructor(options: OpenAIBatchAdapterOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.endpoint = options.endpoint ?? '/v1/chat/completions';
  }

  /**
   * Submit a batch of requests to the OpenAI Batch API.
   *
   * Two-step process:
   * 1. Build JSONL content and upload via the Files API with purpose "batch".
   * 2. Create a batch referencing the uploaded file ID.
   */
  async submitBatch(requests: NorushRequest[]): Promise<ProviderBatchRef> {
    // Step 1: Build JSONL and upload
    const jsonlContent = buildJsonl(requests, this.endpoint);
    const file = await this.client.files.create({
      file: await toFile(
        new Blob([jsonlContent], { type: 'application/jsonl' }),
        'batch-input.jsonl',
      ),
      purpose: 'batch',
    });

    // Step 2: Create batch
    const batch = await this.client.batches.create({
      input_file_id: file.id,
      endpoint: this.endpoint,
      completion_window: '24h',
    });

    return {
      providerBatchId: batch.id,
      provider: 'openai',
    };
  }

  /**
   * Check the current status of a submitted batch.
   */
  async checkStatus(ref: ProviderBatchRef): Promise<BatchStatus> {
    const batch = await this.client.batches.retrieve(ref.providerBatchId);
    return mapStatus(batch.status);
  }

  /**
   * Fetch results for a completed batch.
   *
   * Downloads the output file by output_file_id, parses JSONL line-by-line,
   * and yields NorushResult objects. Also checks the error_file_id for
   * failed requests.
   */
  async *fetchResults(ref: ProviderBatchRef): AsyncIterable<NorushResult> {
    const batch = await this.client.batches.retrieve(ref.providerBatchId);

    // Yield successful results from the output file
    if (batch.output_file_id) {
      yield* this.parseOutputFile(batch.output_file_id);
    }

    // Yield error results from the error file
    if (batch.error_file_id) {
      yield* this.parseOutputFile(batch.error_file_id);
    }
  }

  /**
   * Cancel a batch that is in progress.
   *
   * The batch will transition to "cancelling" and then "cancelled".
   * Partial results may be available in the output file.
   */
  async cancelBatch(ref: ProviderBatchRef): Promise<void> {
    await this.client.batches.cancel(ref.providerBatchId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Download and parse an OpenAI batch output/error JSONL file.
   *
   * Downloads the full file content and processes it line-by-line.
   * Note: The OpenAI Files API returns completed output as a single
   * response body, so the full text is loaded before parsing.
   */
  private async *parseOutputFile(fileId: string): AsyncIterable<NorushResult> {
    const response = await this.client.files.content(fileId);
    const text = await response.text();

    for (const rawLine of text.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      const parsed = JSON.parse(trimmed) as OpenAIOutputLine;
      yield mapResult(parsed);
    }
  }
}
