/**
 * Tests for the /api/v1/flush route handler.
 *
 * Tests manual flush trigger, authentication, and response format.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFlush = vi.fn();

vi.mock('$lib/server/norush', () => ({
  getSql: () => mockSql,
  getEngine: () => Promise.resolve({ flush: mockFlush }),
}));

vi.mock('$lib/server/api-auth', () => ({
  authenticateApiRequest: (_sql: unknown, authHeader: string | null) => {
    if (authHeader === 'Bearer valid_token') {
      return Promise.resolve({ userId: 'user_01', tokenId: 'tok_01' });
    }
    return Promise.resolve(null);
  },
}));

// ---------------------------------------------------------------------------
// Mock SQL
// ---------------------------------------------------------------------------

const mockSql = new Proxy(
  (() => {
    /* noop */
  }) as unknown as import('postgres').Sql,
  {
    apply: () => {
      return Promise.resolve(Object.assign([], { count: 0 }));
    },
  },
);

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import { POST } from '../../../src/routes/api/v1/flush/+server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(authHeader = 'Bearer valid_token') {
  const url = new URL('http://localhost/api/v1/flush');

  return {
    request: new Request(url.toString(), {
      method: 'POST',
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    url,
    locals: {},
    params: {},
    cookies: {} as never,
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
    platform: undefined,
    route: { id: '/api/v1/flush' },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockFlush.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/flush', () => {
  it('rejects unauthenticated requests', async () => {
    const event = makeEvent('');
    const response = await POST(event as never);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe('unauthorized');
  });

  it('triggers a flush and returns success', async () => {
    const event = makeEvent();
    const response = await POST(event as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.message).toBe('Flush triggered successfully');
    expect(data.flushedAt).toBeDefined();
    expect(mockFlush).toHaveBeenCalledOnce();
  });

  it('returns ISO timestamp in flushedAt', async () => {
    const event = makeEvent();
    const response = await POST(event as never);
    const data = await response.json();

    // Verify it's a valid ISO date
    const parsed = new Date(data.flushedAt);
    expect(parsed.getTime()).not.toBeNaN();
  });
});
