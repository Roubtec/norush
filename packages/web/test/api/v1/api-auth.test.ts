/**
 * Tests for the API token authentication module.
 *
 * Tests token generation, hashing, validation, extraction,
 * and CRUD operations (create, list, revoke).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ulidx before importing the module
vi.mock('ulidx', () => ({
  ulid: () => '01TESTULID000000000000000',
}));

import {
  generateToken,
  hashToken,
  tokenDisplayPrefix,
  extractBearerToken,
  validateApiToken,
  authenticateApiRequest,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '$lib/server/api-auth';

// ---------------------------------------------------------------------------
// Mock SQL helper
// ---------------------------------------------------------------------------

function createMockSql(rows: Record<string, unknown>[] = []) {
  const result = Object.assign(rows, { count: rows.length });
  const fn = vi.fn().mockResolvedValue(result);

  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    return fn(strings, ..._values);
  };

  // Attach the mock fn so tests can inspect calls
  (sql as unknown as Record<string, unknown>).__fn = fn;

  return sql as unknown as import('postgres').Sql;
}

function createMockSqlWithCatch(rows: Record<string, unknown>[] = []) {
  const result = Object.assign(rows, { count: rows.length });
  const promiseResult = Promise.resolve(result);
  // Add catch method to the promise for the fire-and-forget update
  (promiseResult as unknown as Record<string, unknown>).catch = vi
    .fn()
    .mockReturnValue(promiseResult);
  const fn = vi.fn().mockReturnValue(promiseResult);

  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    return fn(strings, ..._values);
  };

  (sql as unknown as Record<string, unknown>).__fn = fn;

  return sql as unknown as import('postgres').Sql;
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

describe('generateToken', () => {
  it('generates a token with the nrsh_ prefix', () => {
    const token = generateToken();
    expect(token.startsWith('nrsh_')).toBe(true);
  });

  it('generates a token of expected length (prefix + 64 hex chars)', () => {
    const token = generateToken();
    // "nrsh_" (5) + 32 bytes as hex (64) = 69
    expect(token.length).toBe(69);
  });

  it('generates unique tokens', () => {
    const token1 = generateToken();
    const token2 = generateToken();
    expect(token1).not.toBe(token2);
  });
});

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

describe('hashToken', () => {
  it('returns a consistent SHA-256 hex digest', () => {
    const token = 'nrsh_abc123';
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it('produces different hashes for different tokens', () => {
    const hash1 = hashToken('nrsh_aaa');
    const hash2 = hashToken('nrsh_bbb');
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// Token display prefix
// ---------------------------------------------------------------------------

describe('tokenDisplayPrefix', () => {
  it('returns prefix + first 8 chars of the random part', () => {
    const token = 'nrsh_abcdefgh12345678';
    const prefix = tokenDisplayPrefix(token);
    expect(prefix).toBe('nrsh_abcdefgh');
    expect(prefix).toHaveLength(13); // 5 + 8
  });
});

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------

describe('extractBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    expect(extractBearerToken('Bearer nrsh_abc123')).toBe('nrsh_abc123');
  });

  it('is case-insensitive for Bearer prefix', () => {
    expect(extractBearerToken('bearer nrsh_abc123')).toBe('nrsh_abc123');
  });

  it('returns null for missing header', () => {
    expect(extractBearerToken(null)).toBeNull();
  });

  it('returns null for empty header', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
  });

  it('returns null for malformed header (no space)', () => {
    expect(extractBearerToken('Bearernrsh_abc123')).toBeNull();
  });

  it('returns null for header with extra parts', () => {
    expect(extractBearerToken('Bearer abc 123')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateApiToken
// ---------------------------------------------------------------------------

describe('validateApiToken', () => {
  it('returns caller identity for a valid token', async () => {
    const sql = createMockSqlWithCatch([
      { id: 'tok_01', user_id: 'user_01', expires_at: null, revoked_at: null },
    ]);

    const caller = await validateApiToken(sql, 'nrsh_validtoken');
    expect(caller).toEqual({ userId: 'user_01', tokenId: 'tok_01' });
  });

  it('returns null for an unknown token', async () => {
    const sql = createMockSql([]);
    const caller = await validateApiToken(sql, 'nrsh_unknown');
    expect(caller).toBeNull();
  });

  it('returns null for a revoked token', async () => {
    const sql = createMockSql([
      { id: 'tok_01', user_id: 'user_01', expires_at: null, revoked_at: '2025-01-01T00:00:00Z' },
    ]);

    const caller = await validateApiToken(sql, 'nrsh_revoked');
    expect(caller).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const sql = createMockSql([
      { id: 'tok_01', user_id: 'user_01', expires_at: '2020-01-01T00:00:00Z', revoked_at: null },
    ]);

    const caller = await validateApiToken(sql, 'nrsh_expired');
    expect(caller).toBeNull();
  });

  it('returns caller for a token with future expiry', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const sql = createMockSqlWithCatch([
      { id: 'tok_01', user_id: 'user_01', expires_at: future, revoked_at: null },
    ]);

    const caller = await validateApiToken(sql, 'nrsh_future');
    expect(caller).not.toBeNull();
    expect(caller?.userId).toBe('user_01');
  });
});

// ---------------------------------------------------------------------------
// authenticateApiRequest
// ---------------------------------------------------------------------------

describe('authenticateApiRequest', () => {
  it('returns null for missing Authorization header', async () => {
    const sql = createMockSql([]);
    const caller = await authenticateApiRequest(sql, null);
    expect(caller).toBeNull();
  });

  it('returns null for invalid Authorization scheme', async () => {
    const sql = createMockSql([]);
    const caller = await authenticateApiRequest(sql, 'Basic abc123');
    expect(caller).toBeNull();
  });

  it('returns caller for valid Bearer token', async () => {
    const sql = createMockSqlWithCatch([
      { id: 'tok_01', user_id: 'user_01', expires_at: null, revoked_at: null },
    ]);

    const caller = await authenticateApiRequest(sql, 'Bearer nrsh_validtoken');
    expect(caller).toEqual({ userId: 'user_01', tokenId: 'tok_01' });
  });
});

// ---------------------------------------------------------------------------
// createApiToken
// ---------------------------------------------------------------------------

describe('createApiToken', () => {
  it('creates a token and returns the plaintext', async () => {
    const sql = createMockSql();
    const created = await createApiToken(sql, 'user_01', 'My Token');

    expect(created.id).toBe('01TESTULID000000000000000');
    expect(created.token.startsWith('nrsh_')).toBe(true);
    expect(created.tokenPrefix).toHaveLength(13); // "nrsh_" + 8 chars
    expect(created.label).toBe('My Token');
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('uses default label when not provided', async () => {
    const sql = createMockSql();
    const created = await createApiToken(sql, 'user_01');
    expect(created.label).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// listApiTokens
// ---------------------------------------------------------------------------

describe('listApiTokens', () => {
  it('returns token records without plaintext', async () => {
    const sql = createMockSql([
      {
        id: 'tok_01',
        label: 'Default',
        token_prefix: 'nrsh_abcdefgh',
        last_used_at: '2025-06-01T00:00:00Z',
        expires_at: null,
        revoked_at: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const tokens = await listApiTokens(sql, 'user_01');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).toBe('tok_01');
    expect(tokens[0].label).toBe('Default');
    expect(tokens[0].tokenPrefix).toBe('nrsh_abcdefgh');
    expect(tokens[0].lastUsedAt).toEqual(new Date('2025-06-01T00:00:00Z'));
    expect(tokens[0].expiresAt).toBeNull();
    expect(tokens[0].revokedAt).toBeNull();
  });

  it('returns empty array when user has no tokens', async () => {
    const sql = createMockSql([]);
    const tokens = await listApiTokens(sql, 'user_01');
    expect(tokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// revokeApiToken
// ---------------------------------------------------------------------------

describe('revokeApiToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when token is revoked', async () => {
    const rows = Object.assign([], { count: 1 });
    const fn = vi.fn().mockResolvedValue(rows);
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) =>
      fn(strings, ..._values)) as unknown as import('postgres').Sql;

    const result = await revokeApiToken(sql, 'user_01', 'tok_01');
    expect(result).toBe(true);
  });

  it('returns false when token is not found', async () => {
    const rows = Object.assign([], { count: 0 });
    const fn = vi.fn().mockResolvedValue(rows);
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) =>
      fn(strings, ..._values)) as unknown as import('postgres').Sql;

    const result = await revokeApiToken(sql, 'user_01', 'nonexistent');
    expect(result).toBe(false);
  });
});
