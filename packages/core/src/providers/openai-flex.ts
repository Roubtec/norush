/**
 * OpenAI Flex provider adapter.
 *
 * Implements the Provider interface using synchronous OpenAI API calls with
 * `service_tier: "flex"`. Flex processing offers batch-tier pricing (50% off)
 * with synchronous semantics — each request is sent individually and awaited.
 *
 * Key behaviours:
 * - Adds `service_tier: "flex"` to every request body.
 * - 15-minute SDK timeout (900,000ms) per request.
 * - Retries 429 responses with exponential backoff (Flex 429s indicate
 *   temporary resource unavailability, not account-level rate limits).
 * - Results are available immediately after submitBatch returns.
 */

import OpenAI from "openai";
import type { Provider } from "../interfaces/provider.js";
import type {
  BatchStatus,
  NorushRequest,
  NorushResult,
  ProviderBatchRef,
} from "../types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenAIFlexAdapterOptions {
  /** OpenAI API key. Passed to the SDK constructor. */
  apiKey: string;
  /** Optional base URL override (e.g. for proxies or testing). */
  baseURL?: string;
  /**
   * Maximum number of retry attempts on 429 responses.
   * Defaults to 5.
   */
  maxRetries?: number;
  /**
   * Base delay in milliseconds for exponential backoff on 429 retries.
   * Defaults to 1000.
   */
  baseDelayMs?: number;
  /**
   * SDK timeout in milliseconds. Defaults to 900,000 (15 minutes).
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default SDK timeout: 15 minutes (per PLAN.md recommendation). */
const DEFAULT_TIMEOUT_MS = 900_000;

/** Default max retries for 429 responses. */
const DEFAULT_MAX_RETRIES = 5;

/** Default base delay for exponential backoff. */
const DEFAULT_BASE_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Result mapping helpers
// ---------------------------------------------------------------------------

/**
 * Extract token usage from an OpenAI chat completion response.
 */
function extractUsage(response: Record<string, unknown>): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const usage = response.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  if (!usage) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
  };
}

/**
 * Extract the stop/finish reason from an OpenAI chat completion response.
 */
function extractStopReason(response: Record<string, unknown>): string | null {
  const choices = response.choices as
    | Array<{ finish_reason?: string }>
    | undefined;
  if (choices?.[0]?.finish_reason) return choices[0].finish_reason;
  return null;
}

// ---------------------------------------------------------------------------
// 429 detection
// ---------------------------------------------------------------------------

/**
 * Check if an error is a 429 (rate limit / resource unavailable) response.
 */
function is429Error(err: unknown): boolean {
  // OpenAI SDK throws APIError with a `status` property
  if (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    (err as { status: unknown }).status === 429
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIFlexAdapter implements Provider {
  private readonly client: OpenAI;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  /**
   * In-memory cache of results from the latest submitBatch call.
   * Keyed by the synthetic batch reference ID.
   */
  private readonly resultCache = new Map<string, NorushResult[]>();

  /** Counter for generating synthetic batch IDs. */
  private batchCounter = 0;

  /** Sleep function — injectable for testing. */
  public _sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(options: OpenAIFlexAdapterOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  /**
   * Submit requests synchronously via OpenAI's chat completions API with
   * `service_tier: "flex"`.
   *
   * Each request is sent individually and awaited. Results are cached
   * in memory and returned via fetchResults. Requests are processed
   * serially to respect rate limits.
   */
  async submitBatch(requests: NorushRequest[]): Promise<ProviderBatchRef> {
    const batchId = `flex_${++this.batchCounter}_${Date.now()}`;
    const results: NorushResult[] = [];

    for (const req of requests) {
      const result = await this.sendSingleRequest(req);
      results.push(result);
    }

    this.resultCache.set(batchId, results);

    return {
      providerBatchId: batchId,
      provider: "openai",
    };
  }

  /**
   * Flex requests are synchronous — status is always "ended" once
   * submitBatch has returned.
   */
  async checkStatus(_ref: ProviderBatchRef): Promise<BatchStatus> {
    return "ended";
  }

  /**
   * Yield the cached results from the synchronous submission.
   */
  async *fetchResults(ref: ProviderBatchRef): AsyncIterable<NorushResult> {
    const results = this.resultCache.get(ref.providerBatchId);
    if (!results) return;

    for (const result of results) {
      yield result;
    }

    // Clean up after yielding all results
    this.resultCache.delete(ref.providerBatchId);
  }

  /**
   * Cancel is a no-op for Flex — requests are synchronous and already
   * completed by the time submitBatch returns.
   */
  async cancelBatch(_ref: ProviderBatchRef): Promise<void> {
    // Nothing to cancel; clean up any cached results.
    this.resultCache.delete(_ref.providerBatchId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a single request to the OpenAI chat completions API with Flex tier.
   * Retries on 429 with exponential backoff.
   */
  private async sendSingleRequest(req: NorushRequest): Promise<NorushResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          ...req.params,
          model: req.model,
          service_tier: "flex",
        } as OpenAI.ChatCompletionCreateParamsNonStreaming);

        const body = response as unknown as Record<string, unknown>;
        const { inputTokens, outputTokens } = extractUsage(body);
        const stopReason = extractStopReason(body);

        return {
          requestId: req.id,
          response: body,
          success: true,
          stopReason,
          inputTokens,
          outputTokens,
        };
      } catch (err: unknown) {
        lastError = err;

        if (is429Error(err) && attempt < this.maxRetries) {
          // Exponential backoff with jitter
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          await this._sleep(delay);
          continue;
        }

        // Non-retryable error or max retries exhausted
        break;
      }
    }

    // All attempts failed — return an error result
    const errorResponse: Record<string, unknown> = lastError instanceof Error
      ? { error: lastError.message }
      : { error: "unknown_error" };

    return {
      requestId: req.id,
      response: errorResponse,
      success: false,
      stopReason: null,
      inputTokens: null,
      outputTokens: null,
    };
  }
}
