/**
 * Claude (Anthropic Message Batches) provider adapter.
 *
 * Implements the Provider interface using the @anthropic-ai/sdk package.
 * Submits batches as JSON arrays of { custom_id, params }, checks status
 * by polling the batch endpoint, fetches results via the SDK's JSONL
 * results() iterator, and supports batch cancellation.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageBatchIndividualResponse } from '@anthropic-ai/sdk/resources/messages/batches.js';
import type { Provider } from '../interfaces/provider.js';
import type { BatchStatus, NorushRequest, NorushResult, ProviderBatchRef } from '../types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaudeAdapterOptions {
  /** Anthropic API key. Passed to the SDK constructor. */
  apiKey: string;
  /** Optional base URL override (e.g. for proxies or testing). */
  baseURL?: string;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map Anthropic batch `processing_status` to norush `BatchStatus`.
 *
 * Anthropic statuses: in_progress | canceling | ended
 */
function mapStatus(processingStatus: 'in_progress' | 'canceling' | 'ended'): BatchStatus {
  switch (processingStatus) {
    case 'in_progress':
    case 'canceling':
      return 'processing';
    case 'ended':
      return 'ended';
  }
}

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

/**
 * Convert a single Anthropic batch result line into a NorushResult.
 *
 * The result can be one of: succeeded, errored, canceled, expired.
 * We normalize all of these into NorushResult with the `success` flag.
 */
function mapResult(line: MessageBatchIndividualResponse): NorushResult {
  const requestId = line.custom_id;
  const result = line.result;

  switch (result.type) {
    case 'succeeded': {
      const msg = result.message;
      return {
        requestId,
        response: msg as unknown as Record<string, unknown>,
        success: true,
        stopReason: msg.stop_reason,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
      };
    }
    case 'errored':
      return {
        requestId,
        response: result.error as unknown as Record<string, unknown>,
        success: false,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
      };
    case 'canceled':
      return {
        requestId,
        response: { type: 'canceled' },
        success: false,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
      };
    case 'expired':
      return {
        requestId,
        response: { type: 'expired' },
        success: false,
        stopReason: null,
        inputTokens: null,
        outputTokens: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter implements Provider {
  private readonly client: Anthropic;

  constructor(options: ClaudeAdapterOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  /**
   * Submit a batch of requests to the Anthropic Message Batches API.
   *
   * Each NorushRequest is mapped to { custom_id, params } where custom_id
   * is the norush request id (enabling trivial round-trip mapping) and
   * params is the provider-specific message creation body.
   */
  async submitBatch(requests: NorushRequest[]): Promise<ProviderBatchRef> {
    const batch = await this.client.messages.batches.create({
      requests: requests.map((req) => {
        // Validate messages - required by Anthropic API; default silently
        // masking caller bugs, so we require a valid array.
        if (!Array.isArray(req.params.messages)) {
          throw new Error(
            `ClaudeAdapter: request "${req.id}" must include a "messages" array in params`,
          );
        }

        // Validate max_tokens - must be a number if provided.
        const maxTokensParam = req.params.max_tokens;
        if (maxTokensParam !== undefined && typeof maxTokensParam !== 'number') {
          throw new Error(
            `ClaudeAdapter: request "${req.id}" has invalid "max_tokens" in params: expected a number, got ${typeof maxTokensParam}`,
          );
        }

        return {
          custom_id: req.id,
          params: {
            ...req.params,
            // req.model takes precedence over any model key in params.
            model: req.model,
            // Anthropic requires max_tokens; default to 4096 if not supplied.
            max_tokens: typeof maxTokensParam === 'number' ? maxTokensParam : 4096,
            messages: req.params.messages as Anthropic.MessageParam[],
          },
        };
      }),
    });

    return {
      providerBatchId: batch.id,
      provider: 'claude',
    };
  }

  /**
   * Check the current status of a submitted batch.
   */
  async checkStatus(ref: ProviderBatchRef): Promise<BatchStatus> {
    const batch = await this.client.messages.batches.retrieve(ref.providerBatchId);
    return mapStatus(batch.processing_status);
  }

  /**
   * Fetch results for a completed batch.
   *
   * Returns an AsyncIterable that yields NorushResult objects one at a time
   * as the SDK streams them from the JSONL results endpoint.
   */
  async *fetchResults(ref: ProviderBatchRef): AsyncIterable<NorushResult> {
    const decoder = await this.client.messages.batches.results(ref.providerBatchId);

    for await (const line of decoder) {
      yield mapResult(line);
    }
  }

  /**
   * Cancel a batch that is in progress.
   *
   * After cancellation is initiated, the batch enters "canceling" state.
   * Some requests may still complete before the batch fully ends.
   */
  async cancelBatch(ref: ProviderBatchRef): Promise<void> {
    await this.client.messages.batches.cancel(ref.providerBatchId);
  }
}
