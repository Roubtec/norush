/**
 * Webhook HTTP delivery.
 *
 * POSTs a JSON payload to a callback URL with:
 *   - `Content-Type: application/json`
 *   - `X-Norush-Signature` (HMAC-SHA256, only when `webhookSecret` is set)
 *   - `X-Norush-Attempt` (current attempt number, 1-based)
 *   - `X-Norush-Request-Id` (norush request ID for correlation)
 *
 * The payload includes `norush_id` for consumer-side deduplication.
 *
 * Throws on non-2xx responses or network errors so the delivery worker
 * can retry with exponential backoff.
 */

import type { Request, Result } from "../types.js";
import { signWebhookPayload } from "./sign.js";

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

/** Result of a webhook delivery attempt. */
export interface DeliveryResult {
  ok: boolean;
  statusCode: number | null;
  error?: string;
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
export function buildWebhookPayload(
  result: Result,
  request: Request,
): WebhookPayload {
  return {
    norush_id: request.id,
    status: request.status === "succeeded" ? "succeeded" : "failed",
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
export async function deliverWebhook(
  options: DeliverWebhookOptions,
): Promise<DeliveryResult> {
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

  // Build headers.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Norush-Attempt": String(attempt),
    "X-Norush-Request-Id": requestId,
  };

  // Sign the payload if a webhook secret is provided.
  if (webhookSecret) {
    headers["X-Norush-Signature"] = signWebhookPayload(webhookSecret, body);
  }

  // Use AbortController for timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(callbackUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const statusText = response.statusText || `HTTP ${response.status}`;
      throw new Error(
        `Webhook delivery failed: ${statusText} (status ${response.status})`,
      );
    }

    return { ok: true, statusCode: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Webhook delivery timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
