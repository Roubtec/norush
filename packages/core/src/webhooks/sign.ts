/**
 * HMAC-SHA256 webhook signature computation.
 *
 * Produces a hex-encoded signature for webhook payloads so consumers can
 * verify authenticity. The signature is sent in the `X-Norush-Signature`
 * header.
 *
 * Formula: HMAC-SHA256(webhook_secret, JSON.stringify(body))
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute an HMAC-SHA256 signature for a webhook payload.
 *
 * @param secret - The webhook secret (shared with the consumer).
 * @param body - The serialised JSON body string to sign.
 * @returns The hex-encoded HMAC-SHA256 signature.
 */
export function signWebhookPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Verify an HMAC-SHA256 signature against a payload.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * Accepts both the `sha256=<hex>` prefixed format (as sent in headers)
 * and the raw hex format.
 *
 * When verifying timestamp-bound signatures (as produced by the delivery
 * helper), pass the canonical signing input as the `body` argument:
 * `verifyWebhookSignature(secret, \`${timestamp}.${rawBody}\`, signature)`
 *
 * @param secret - The webhook secret.
 * @param body - The signing input (raw body or `"<timestamp>.<body>"`).
 * @param signature - The signature to verify (`sha256=<hex>` or raw hex).
 * @returns True if the signature is valid.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  // Strip optional `sha256=` prefix so callers can pass the header value directly.
  const hex = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  const expected = signWebhookPayload(secret, body);

  // Timing-safe comparison requires equal-length buffers.
  if (expected.length !== hex.length) return false;

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hex, "hex");

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
