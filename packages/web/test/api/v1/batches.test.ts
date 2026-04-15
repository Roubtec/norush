/**
 * Tests for the /api/v1/batches route handlers.
 *
 * Tests batch listing, single batch retrieval, authentication,
 * and pagination.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('$lib/server/norush', () => ({
  getSql: () => mockSql,
  getEngine: () => Promise.resolve({}),
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

let mockSqlResult: Record<string, unknown>[] = [];

const mockSql = new Proxy(
  (() => {
    /* noop */
  }) as unknown as import('postgres').Sql,
  {
    apply: () => {
      const rows = [...mockSqlResult];
      return Promise.resolve(Object.assign(rows, { count: rows.length }));
    },
  },
);

// ---------------------------------------------------------------------------
// Import handlers
// ---------------------------------------------------------------------------

import { GET as listBatches } from '../../../src/routes/api/v1/batches/+server';
import { GET as getBatch } from '../../../src/routes/api/v1/batches/[id]/+server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeListEvent(authHeader = 'Bearer valid_token', searchParams?: URLSearchParams) {
  const url = new URL('http://localhost/api/v1/batches');
  if (searchParams) {
    searchParams.forEach((v, k) => url.searchParams.set(k, v));
  }

  return {
    request: new Request(url.toString(), {
      method: 'GET',
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
    route: { id: '/api/v1/batches' },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

function makeSingleEvent(id: string, authHeader = 'Bearer valid_token') {
  const url = new URL(`http://localhost/api/v1/batches/${id}`);

  return {
    request: new Request(url.toString(), {
      method: 'GET',
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    url,
    locals: {},
    params: { id },
    cookies: {} as never,
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
    platform: undefined,
    route: { id: '/api/v1/batches/[id]' },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockSqlResult = [];
});

// ---------------------------------------------------------------------------
// GET /api/v1/batches (list)
// ---------------------------------------------------------------------------

describe('GET /api/v1/batches', () => {
  it('rejects unauthenticated requests', async () => {
    const event = makeListEvent('');
    const response = await listBatches(event as never);
    expect(response.status).toBe(401);
  });

  it('returns paginated batch list', async () => {
    const now = new Date('2025-06-15T10:00:00Z');
    mockSqlResult = [
      {
        id: 'batch_01',
        provider: 'claude',
        status: 'ended',
        request_count: 5,
        succeeded_count: 4,
        failed_count: 1,
        submitted_at: now,
        ended_at: now,
        created_at: now,
        updated_at: now,
      },
    ];

    const event = makeListEvent();
    const response = await listBatches(event as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.batches).toHaveLength(1);
    expect(data.batches[0].id).toBe('batch_01');
    expect(data.batches[0].provider).toBe('claude');
    expect(data.batches[0].requestCount).toBe(5);
    expect(data.batches[0].succeededCount).toBe(4);
    expect(data.batches[0].failedCount).toBe(1);
    expect(data.pagination).toBeDefined();
    expect(data.pagination.hasMore).toBe(false);
  });

  it('returns empty list when no batches exist', async () => {
    mockSqlResult = [];
    const event = makeListEvent();
    const response = await listBatches(event as never);
    const data = await response.json();
    expect(data.batches).toEqual([]);
    expect(data.pagination.hasMore).toBe(false);
    expect(data.pagination.cursor).toBeNull();
  });

  it('respects limit parameter', async () => {
    mockSqlResult = [];
    const event = makeListEvent('Bearer valid_token', new URLSearchParams({ limit: '10' }));
    const response = await listBatches(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(10);
  });

  it('clamps limit to 100', async () => {
    mockSqlResult = [];
    const event = makeListEvent('Bearer valid_token', new URLSearchParams({ limit: '500' }));
    const response = await listBatches(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(100);
  });

  it('clamps limit=0 to minimum of 1', async () => {
    mockSqlResult = [];
    const event = makeListEvent('Bearer valid_token', new URLSearchParams({ limit: '0' }));
    const response = await listBatches(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(1);
  });

  it('defaults limit to 50 for non-numeric input', async () => {
    mockSqlResult = [];
    const event = makeListEvent('Bearer valid_token', new URLSearchParams({ limit: 'abc' }));
    const response = await listBatches(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(50);
  });

  it('handles batches without submitted_at or ended_at', async () => {
    const now = new Date('2025-06-15T10:00:00Z');
    mockSqlResult = [
      {
        id: 'batch_02',
        provider: 'openai',
        status: 'pending',
        request_count: 3,
        succeeded_count: 0,
        failed_count: 0,
        submitted_at: null,
        ended_at: null,
        created_at: now,
        updated_at: now,
      },
    ];

    const event = makeListEvent();
    const response = await listBatches(event as never);
    const data = await response.json();
    expect(data.batches[0].submittedAt).toBeNull();
    expect(data.batches[0].endedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/batches/:id (single)
// ---------------------------------------------------------------------------

describe('GET /api/v1/batches/:id', () => {
  it('rejects unauthenticated requests', async () => {
    const event = makeSingleEvent('batch_01', '');
    const response = await getBatch(event as never);
    expect(response.status).toBe(401);
  });

  it('returns 404 for non-existent batch', async () => {
    mockSqlResult = [];
    const event = makeSingleEvent('batch_nonexistent');
    const response = await getBatch(event as never);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe('not_found');
  });

  it('returns batch with request summary', async () => {
    const now = new Date('2025-06-15T10:00:00Z');

    // The handler makes two SQL calls: first for the batch, then for the summary.
    // We need to track call count and return different results.
    let callCount = 0;
    const batchRow = {
      id: 'batch_01',
      provider: 'claude',
      provider_batch_id: 'msgbatch_123',
      status: 'ended',
      request_count: 5,
      succeeded_count: 4,
      failed_count: 1,
      submission_attempts: 1,
      polling_strategy: null,
      submitted_at: now,
      ended_at: now,
      created_at: now,
      updated_at: now,
    };
    const summaryRows = [
      { status: 'succeeded', count: 4 },
      { status: 'failed', count: 1 },
    ];

    const proxiedSql = new Proxy(
      (() => {
        /* noop */
      }) as unknown as import('postgres').Sql,
      {
        apply: () => {
          callCount++;
          if (callCount === 1) {
            // First proxied SQL call: batch query
            const rows = [batchRow];
            return Promise.resolve(Object.assign(rows, { count: rows.length }));
          }
          // Second proxied SQL call: summary query
          const rows = [...summaryRows];
          return Promise.resolve(Object.assign(rows, { count: rows.length }));
        },
      },
    );

    // Override the mock for this test
    const origGetSql = await import('$lib/server/norush');
    const getSqlSpy = vi.spyOn(origGetSql, 'getSql').mockReturnValue(proxiedSql);

    const event = makeSingleEvent('batch_01');
    const response = await getBatch(event as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.batch.id).toBe('batch_01');
    expect(data.batch.provider).toBe('claude');
    expect(data.batch.providerBatchId).toBe('msgbatch_123');
    expect(data.batch.requestSummary).toBeDefined();
    expect(data.batch.requestSummary.succeeded).toBe(4);
    expect(data.batch.requestSummary.failed).toBe(1);

    getSqlSpy.mockRestore();
  });
});
