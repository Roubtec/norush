import { describe, expect, it, vi } from 'vitest';
import {
  deliverWebhook,
  buildWebhookPayload,
  type WebhookPayload,
} from '../../webhooks/deliver.js';
import { signWebhookPayload } from '../../webhooks/sign.js';
import type { Request, Result } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'req_001',
    externalId: null,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    params: { max_tokens: 1024 },
    status: 'succeeded',
    batchId: 'batch_001',
    userId: 'user_01',
    callbackUrl: 'https://example.com/webhook',
    webhookSecret: null,
    retryCount: 0,
    maxRetries: 3,
    contentScrubbedAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeResult(overrides: Partial<Result> = {}): Result {
  return {
    id: 'res_001',
    requestId: 'req_001',
    batchId: 'batch_001',
    response: { content: 'Hello from the model' },
    stopReason: 'end_turn',
    inputTokens: 100,
    outputTokens: 200,
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    maxDeliveryAttempts: 5,
    lastDeliveryError: null,
    nextDeliveryAt: null,
    deliveredAt: null,
    contentScrubbedAt: null,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function mockFetchOk(): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(new Response('OK', { status: 200, statusText: 'OK' }));
}

function mockFetchError(status: number, statusText: string): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(new Response('Error', { status, statusText }));
}

function mockFetchNetworkError(): typeof globalThis.fetch {
  return vi.fn().mockRejectedValue(new TypeError('fetch failed'));
}

// ---------------------------------------------------------------------------
// buildWebhookPayload tests
// ---------------------------------------------------------------------------

describe('buildWebhookPayload', () => {
  it('builds the correct payload structure', () => {
    const request = makeRequest({
      id: 'req_abc',
      model: 'claude-sonnet-4-6',
      provider: 'claude',
      status: 'succeeded',
    });
    const result = makeResult({ response: { text: 'Hi' }, inputTokens: 10, outputTokens: 20 });

    const payload = buildWebhookPayload(result, request);

    expect(payload).toEqual({
      norush_id: 'req_abc',
      status: 'succeeded',
      response: { text: 'Hi' },
      input_tokens: 10,
      output_tokens: 20,
      model: 'claude-sonnet-4-6',
      provider: 'claude',
    });
  });

  it('maps non-succeeded request status to failed', () => {
    const request = makeRequest({ status: 'failed' });
    const result = makeResult();

    const payload = buildWebhookPayload(result, request);
    expect(payload.status).toBe('failed');
  });

  it('handles null token counts', () => {
    const request = makeRequest();
    const result = makeResult({ inputTokens: null, outputTokens: null });

    const payload = buildWebhookPayload(result, request);
    expect(payload.input_tokens).toBeNull();
    expect(payload.output_tokens).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deliverWebhook tests
// ---------------------------------------------------------------------------

describe('deliverWebhook', () => {
  const basePayload: WebhookPayload = {
    norush_id: 'req_001',
    status: 'succeeded',
    response: { content: 'Hello' },
    input_tokens: 100,
    output_tokens: 200,
    model: 'claude-sonnet-4-6',
    provider: 'claude',
  };

  it('sends a POST request with correct headers', async () => {
    const fetchFn = mockFetchOk();

    await deliverWebhook({
      callbackUrl: 'https://example.com/hook',
      payload: basePayload,
      attempt: 1,
      requestId: 'req_001',
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Norush-Attempt']).toBe('1');
    expect(headers['X-Norush-Request-Id']).toBe('req_001');
  });

  it('includes X-Norush-Timestamp header with Unix epoch seconds', async () => {
    const fetchFn = mockFetchOk();
    const before = Math.floor(Date.now() / 1000);

    await deliverWebhook({
      callbackUrl: 'https://example.com/hook',
      payload: basePayload,
      attempt: 1,
      requestId: 'req_001',
      fetchFn,
    });

    const after = Math.floor(Date.now() / 1000);
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const timestamp = Number(headers['X-Norush-Timestamp']);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('includes HMAC signature with sha256= prefix when webhookSecret is set', async () => {
    const fetchFn = mockFetchOk();
    const secret = 'my-secret';

    await deliverWebhook({
      callbackUrl: 'https://example.com/hook',
      payload: basePayload,
      webhookSecret: secret,
      attempt: 1,
      requestId: 'req_001',
      fetchFn,
    });

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    // Signature covers the canonical input "<timestamp>.<body>" so the
    // timestamp is bound to the signature and cannot be rewritten.
    const timestamp = headers['X-Norush-Timestamp'];
    const body = JSON.stringify(basePayload);
    const expectedHex = signWebhookPayload(secret, `${timestamp}.${body}`);
    expect(headers['X-Norush-Signature']).toBe(`sha256=${expectedHex}`);
  });

  it('omits signature header when no webhookSecret', async () => {
    const fetchFn = mockFetchOk();

    await deliverWebhook({
      callbackUrl: 'https://example.com/hook',
      payload: basePayload,
      webhookSecret: null,
      attempt: 1,
      requestId: 'req_001',
      fetchFn,
    });

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers['X-Norush-Signature']).toBeUndefined();
  });

  it('sends the correct JSON body', async () => {
    const fetchFn = mockFetchOk();

    await deliverWebhook({
      callbackUrl: 'https://example.com/hook',
      payload: basePayload,
      attempt: 1,
      requestId: 'req_001',
      fetchFn,
    });

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify(basePayload));
  });

  it('returns statusCode on 2xx response', async () => {
    const fetchFn = mockFetchOk();

    const result = await deliverWebhook({
      callbackUrl: 'https://example.com/hook',
      payload: basePayload,
      attempt: 1,
      requestId: 'req_001',
      fetchFn,
    });

    expect(result.statusCode).toBe(200);
  });

  it('throws on non-2xx response', async () => {
    const fetchFn = mockFetchError(500, 'Internal Server Error');

    await expect(
      deliverWebhook({
        callbackUrl: 'https://example.com/hook',
        payload: basePayload,
        attempt: 1,
        requestId: 'req_001',
        fetchFn,
      }),
    ).rejects.toThrow(/Webhook delivery failed.*500/);
  });

  it('throws on 404 response', async () => {
    const fetchFn = mockFetchError(404, 'Not Found');

    await expect(
      deliverWebhook({
        callbackUrl: 'https://example.com/hook',
        payload: basePayload,
        attempt: 1,
        requestId: 'req_001',
        fetchFn,
      }),
    ).rejects.toThrow(/Webhook delivery failed.*404/);
  });

  it('throws on network error', async () => {
    const fetchFn = mockFetchNetworkError();

    await expect(
      deliverWebhook({
        callbackUrl: 'https://example.com/hook',
        payload: basePayload,
        attempt: 1,
        requestId: 'req_001',
        fetchFn,
      }),
    ).rejects.toThrow('fetch failed');
  });

  it('reflects the attempt number in X-Norush-Attempt header', async () => {
    const fetchFn = mockFetchOk();

    await deliverWebhook({
      callbackUrl: 'https://example.com/hook',
      payload: basePayload,
      attempt: 3,
      requestId: 'req_001',
      fetchFn,
    });

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Norush-Attempt']).toBe('3');
  });

  it('times out after the configured timeout', async () => {
    // Create a fetch that never resolves.
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    await expect(
      deliverWebhook({
        callbackUrl: 'https://example.com/hook',
        payload: basePayload,
        attempt: 1,
        requestId: 'req_001',
        fetchFn: fetchFn as typeof globalThis.fetch,
        timeoutMs: 10, // Very short timeout
      }),
    ).rejects.toThrow(/timed out/);
  });
});
