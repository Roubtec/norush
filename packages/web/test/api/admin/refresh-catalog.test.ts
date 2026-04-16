/**
 * Tests for POST /api/admin/refresh-catalog.
 *
 * Verifies auth gating (reuses the bearer-token gate), 204 on success,
 * and 500 with detail on failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// vi.mock factories are hoisted, so we stash the spies in a mutable
// object captured by reference inside the factory.
const hoisted = vi.hoisted(() => ({
  mockRefresh: vi.fn<(...args: unknown[]) => unknown>(),
  mockStore: {
    upsertProviderCatalogEntry: vi.fn(),
    listProviderCatalog: vi.fn(),
    getProviderCatalogEntry: vi.fn(),
  },
}));
const { mockRefresh } = hoisted;

vi.mock('$lib/server/norush', () => ({
  getSql: () => mockSql,
  getEngine: () => Promise.resolve({}),
  getStore: () => hoisted.mockStore,
}));

vi.mock('$lib/server/api-auth', () => ({
  authenticateApiRequest: (_sql: unknown, authHeader: string | null) => {
    if (authHeader === 'Bearer valid_token') {
      return Promise.resolve({ userId: 'user_01', tokenId: 'tok_01' });
    }
    return Promise.resolve(null);
  },
}));

vi.mock('$lib/server/catalog', () => ({
  refreshProviderCatalog: hoisted.mockRefresh,
}));

// ---------------------------------------------------------------------------
// Mock SQL
// ---------------------------------------------------------------------------

const mockSql = new Proxy(
  (() => {
    /* noop */
  }) as unknown as import('postgres').Sql,
  {
    apply: () => Promise.resolve(Object.assign([], { count: 0 })),
  },
);

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import { POST } from '../../../src/routes/api/admin/refresh-catalog/+server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(authHeader = 'Bearer valid_token') {
  const url = new URL('http://localhost/api/admin/refresh-catalog');
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
    route: { id: '/api/admin/refresh-catalog' },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/admin/refresh-catalog', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const event = makeEvent('');
    const response = await POST(event as never);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('unauthorized');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('returns 204 on a successful refresh', async () => {
    mockRefresh.mockResolvedValueOnce([
      { provider: 'claude', fetched: 5, upserted: 5 },
      { provider: 'openai', fetched: 4, upserted: 4 },
    ]);
    const event = makeEvent();
    const response = await POST(event as never);
    expect(response.status).toBe(204);
    expect(mockRefresh).toHaveBeenCalledOnce();
  });

  it('returns 204 when a source had an empty_parse skip (parser guard-rail)', async () => {
    // Empty parse is not a hard failure — existing rows are preserved.
    mockRefresh.mockResolvedValueOnce([
      { provider: 'claude', fetched: 5, upserted: 5 },
      { provider: 'openai', fetched: 0, upserted: 0, skipped: 'empty_parse' },
    ]);
    const event = makeEvent();
    const response = await POST(event as never);
    expect(response.status).toBe(204);
  });

  it('returns 500 with detail when a source raised an error', async () => {
    mockRefresh.mockResolvedValueOnce([
      { provider: 'claude', fetched: 0, upserted: 0, skipped: 'error:upstream boom' },
    ]);
    const event = makeEvent();
    const response = await POST(event as never);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('refresh_failed');
    expect(body.error.detail).toBeDefined();
  });

  it('returns 500 when the refresh itself throws', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('catastrophic'));
    const event = makeEvent();
    const response = await POST(event as never);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('refresh_failed');
    expect(body.error.message).toBe('catastrophic');
  });
});
