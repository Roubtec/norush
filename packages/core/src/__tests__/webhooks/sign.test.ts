import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from '../../webhooks/sign.js';

describe('signWebhookPayload', () => {
  it('produces a hex-encoded HMAC-SHA256 signature', () => {
    const secret = 'test-secret';
    const body = JSON.stringify({ norush_id: 'abc', status: 'succeeded' });

    const signature = signWebhookPayload(secret, body);

    // Verify it's a valid hex string (64 chars for SHA-256).
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches the output of crypto.createHmac directly', () => {
    const secret = 'my-webhook-secret';
    const body = '{"hello":"world"}';

    const expected = createHmac('sha256', secret).update(body).digest('hex');

    expect(signWebhookPayload(secret, body)).toBe(expected);
  });

  it('produces different signatures for different secrets', () => {
    const body = '{"data":"test"}';

    const sig1 = signWebhookPayload('secret-a', body);
    const sig2 = signWebhookPayload('secret-b', body);

    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different bodies', () => {
    const secret = 'same-secret';

    const sig1 = signWebhookPayload(secret, '{"a":1}');
    const sig2 = signWebhookPayload(secret, '{"a":2}');

    expect(sig1).not.toBe(sig2);
  });

  it('handles empty body', () => {
    const signature = signWebhookPayload('secret', '');
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles unicode content in body', () => {
    const body = JSON.stringify({ text: 'Hello \u4e16\u754c' });
    const signature = signWebhookPayload('secret', body);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-verify-secret';
  const body = JSON.stringify({ norush_id: '123', status: 'succeeded' });

  it('returns true for a valid signature', () => {
    const signature = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const signature = signWebhookPayload(secret, body);
    const tampered = body.replace('123', '456');
    expect(verifyWebhookSignature(secret, tampered, signature)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const signature = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature('wrong-secret', body, signature)).toBe(false);
  });

  it('returns false for a completely invalid signature', () => {
    expect(verifyWebhookSignature(secret, body, 'not-a-hex-string')).toBe(false);
  });

  it('returns false for a truncated signature', () => {
    const signature = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, signature.slice(0, 32))).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(verifyWebhookSignature(secret, body, '')).toBe(false);
  });

  it('accepts sha256= prefixed signature (header format)', () => {
    const hex = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, `sha256=${hex}`)).toBe(true);
  });

  it('rejects sha256= prefixed signature with wrong body', () => {
    const hex = signWebhookPayload(secret, body);
    const tampered = body.replace('123', '456');
    expect(verifyWebhookSignature(secret, tampered, `sha256=${hex}`)).toBe(false);
  });
});
