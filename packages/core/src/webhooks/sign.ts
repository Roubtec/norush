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
 *
 * @param secret - The webhook secret.
 * @param body - The serialised JSON body string.
 * @param signature - The signature to verify (hex-encoded).
 * @returns True if the signature is valid.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = signWebhookPayload(secret, body);

  // Timing-safe comparison requires equal-length buffers.
  if (expected.length !== signature.length) return false;

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
