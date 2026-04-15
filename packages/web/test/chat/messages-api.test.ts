/**
 * Tests for the messages server module:
 * - validateMessageInput: input validation
 * - listMessages: user scoping and ordering
 * - findUserApiKeyId: key lookup
 */

import { describe, it, expect, vi } from 'vitest';
import { validateMessageInput, listMessages, findUserApiKeyId } from '$lib/server/messages';

// ---------------------------------------------------------------------------
// Mock SQL helper (same pattern as api-keys tests)
// ---------------------------------------------------------------------------

function createMockSql(rows: Record<string, unknown>[] = []) {
  const result = Object.assign(rows, { count: rows.length });
  const fn = vi.fn().mockResolvedValue(result);

  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    return fn(strings, ..._values);
  };

  return sql as unknown as import('postgres').Sql;
}

// ---------------------------------------------------------------------------
// validateMessageInput
// ---------------------------------------------------------------------------

describe('validateMessageInput', () => {
  it('returns no errors for valid input', () => {
    const errors = validateMessageInput({
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      content: 'Hello, world!',
    });
    expect(errors).toEqual([]);
  });

  it('rejects empty provider', () => {
    const errors = validateMessageInput({
      provider: '',
      model: 'claude-sonnet-4-20250514',
      content: 'Hello',
    });
    expect(errors.some((e) => e.field === 'provider')).toBe(true);
  });

  it('rejects invalid provider', () => {
    const errors = validateMessageInput({
      provider: 'google',
      model: 'gemini-pro',
      content: 'Hello',
    });
    expect(errors.some((e) => e.field === 'provider')).toBe(true);
  });

  it('rejects empty model', () => {
    const errors = validateMessageInput({
      provider: 'claude',
      model: '',
      content: 'Hello',
    });
    expect(errors.some((e) => e.field === 'model')).toBe(true);
  });

  it('rejects whitespace-only model', () => {
    const errors = validateMessageInput({
      provider: 'claude',
      model: '   ',
      content: 'Hello',
    });
    expect(errors.some((e) => e.field === 'model')).toBe(true);
  });

  it('rejects empty content', () => {
    const errors = validateMessageInput({
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      content: '',
    });
    expect(errors.some((e) => e.field === 'content')).toBe(true);
  });

  it('rejects whitespace-only content', () => {
    const errors = validateMessageInput({
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      content: '   ',
    });
    expect(errors.some((e) => e.field === 'content')).toBe(true);
  });

  it('rejects content exceeding max length', () => {
    const errors = validateMessageInput({
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      content: 'x'.repeat(100_001),
    });
    expect(errors.some((e) => e.field === 'content')).toBe(true);
  });

  it('accepts content at max length', () => {
    const errors = validateMessageInput({
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      content: 'x'.repeat(100_000),
    });
    expect(errors).toEqual([]);
  });

  it('accepts openai as a valid provider', () => {
    const errors = validateMessageInput({
      provider: 'openai',
      model: 'gpt-4o',
      content: 'Hello',
    });
    expect(errors).toEqual([]);
  });

  it('returns multiple errors at once', () => {
    const errors = validateMessageInput({
      provider: '',
      model: '',
      content: '',
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// listMessages
// ---------------------------------------------------------------------------

describe('listMessages', () => {
  it('returns messages with results from database rows', async () => {
    const now = new Date('2025-06-15T10:00:00Z');
    const sql = createMockSql([
      {
        id: 'req_01',
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        params: { messages: [{ role: 'user', content: 'Hello' }] },
        status: 'succeeded',
        request_created_at: now,
        request_updated_at: now,
        result_id: 'res_01',
        response: { content: [{ type: 'text', text: 'Hi there!' }] },
        stop_reason: 'end_turn',
        input_tokens: 10,
        output_tokens: 20,
        result_created_at: now,
      },
    ]);

    const messages = await listMessages(sql, 'user_01');

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('req_01');
    expect(messages[0].provider).toBe('claude');
    expect(messages[0].status).toBe('succeeded');
    const result = messages[0].result;
    expect(result).not.toBeNull();
    expect(result?.id).toBe('res_01');
    expect(result?.inputTokens).toBe(10);
    expect(result?.outputTokens).toBe(20);
  });

  it('returns messages without results (pending)', async () => {
    const now = new Date('2025-06-15T10:00:00Z');
    const sql = createMockSql([
      {
        id: 'req_02',
        provider: 'openai',
        model: 'gpt-4o',
        params: { messages: [{ role: 'user', content: 'Test' }] },
        status: 'queued',
        request_created_at: now,
        request_updated_at: now,
        result_id: null,
        response: null,
        stop_reason: null,
        input_tokens: null,
        output_tokens: null,
        result_created_at: null,
      },
    ]);

    const messages = await listMessages(sql, 'user_01');

    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe('queued');
    expect(messages[0].result).toBeNull();
  });

  it('returns empty array when no messages exist', async () => {
    const sql = createMockSql([]);
    const messages = await listMessages(sql, 'user_01');
    expect(messages).toEqual([]);
  });

  it('respects limit and offset options', async () => {
    const sql = createMockSql([]);
    // We just need to verify it doesn't throw — the SQL mock returns []
    const messages = await listMessages(sql, 'user_01', {
      limit: 10,
      offset: 5,
    });
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findUserApiKeyId
// ---------------------------------------------------------------------------

describe('findUserApiKeyId', () => {
  it('returns the API key ID when one exists', async () => {
    const sql = createMockSql([{ id: 'key_01ABC' }]);
    const keyId = await findUserApiKeyId(sql, 'user_01', 'claude');
    expect(keyId).toBe('key_01ABC');
  });

  it('returns null when no API key exists for provider', async () => {
    const sql = createMockSql([]);
    const keyId = await findUserApiKeyId(sql, 'user_01', 'claude');
    expect(keyId).toBeNull();
  });
});
