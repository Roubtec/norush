/**
 * Webhook HTTP delivery.
 *
 * POSTs a JSON payload to a callback URL with:
 *   - `Content-Type: application/json`
 *   - `X-Norush-Timestamp` (Unix epoch seconds, included in signing input)
 *   - `X-Norush-Signature` (HMAC-SHA256 of `"<timestamp>.<body>"`, only when `webhookSecret` is set)
 *   - `X-Norush-Attempt` (current attempt number, 1-based)
 *   - `X-Norush-Request-Id` (norush request ID for correlation)
 *
 * The timestamp is bound to the signature so that consumers can verify
 * both authenticity and recency (replay protection). Consumers should
 * verify the signature against `"${X-Norush-Timestamp}.${body}"` and
 * reject deliveries whose timestamp falls outside an allowed clock skew.
 *
 * The payload includes `norush_id` for consumer-side deduplication.
 *
 * Throws on non-2xx responses or network errors so the delivery worker
 * can retry with exponential backoff.
 */

import type { Request, Result } from '../types.js';
import { signWebhookPayload } from './sign.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The JSON payload sent to the webhook consumer. */
export interface WebhookPayload {
  norush_id: string;
  status: string;
  response: Record<string, unknown>;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string;
  provider: string;
}

/** Options for a single webhook delivery attempt. */
export interface DeliverWebhookOptions {
  /** The callback URL to POST to. */
  callbackUrl: string;
  /** The webhook payload body. */
  payload: WebhookPayload;
  /** Optional HMAC secret for signing. */
  webhookSecret?: string | null;
  /** Current attempt number (1-based). */
  attempt: number;
  /** The norush request ID (for the X-Norush-Request-Id header). */
  requestId: string;
  /** Optional fetch implementation for testing. */
  fetchFn?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Default: 30_000. */
  timeoutMs?: number;
}

/**
 * Result of a successful webhook delivery attempt.
 * The function throws on non-2xx responses and network errors, so
 * callers only receive this when delivery actually succeeded.
 */
export interface DeliveryResult {
  statusCode: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for webhook HTTP requests. */
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

/**
 * Build the webhook payload from a result and its associated request.
 */
export function buildWebhookPayload(result: Result, request: Request): WebhookPayload {
  return {
    norush_id: request.id,
    status: request.status === 'succeeded' ? 'succeeded' : 'failed',
    response: result.response,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    model: request.model,
    provider: request.provider,
  };
}

// ---------------------------------------------------------------------------
// Delivery function
// ---------------------------------------------------------------------------

/**
 * Deliver a webhook payload via HTTP POST.
 *
 * Throws an error on non-2xx responses or network failures so the
 * delivery worker can handle retry logic.
 */
export async function deliverWebhook(options: DeliverWebhookOptions): Promise<DeliveryResult> {
  const {
    callbackUrl,
    payload,
    webhookSecret,
    attempt,
    requestId,
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));

  // Build headers.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Norush-Attempt': String(attempt),
    'X-Norush-Request-Id': requestId,
    'X-Norush-Timestamp': timestamp,
  };

  // Sign a canonical string that binds the timestamp to the body so the
  // timestamp cannot be rewritten without invalidating the signature.
  // Signing input: "<timestamp>.<body>"
  if (webhookSecret) {
    const signingInput = `${timestamp}.${body}`;
    headers['X-Norush-Signature'] = `sha256=${signWebhookPayload(webhookSecret, signingInput)}`;
  }

  // Use AbortController for timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(callbackUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const statusText = response.statusText || `HTTP ${response.status}`;
      throw new Error(`Webhook delivery failed: ${statusText} (status ${response.status})`);
    }

    return { statusCode: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Webhook delivery timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
