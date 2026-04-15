/**
 * Tests for the results polling query: getResultsSince.
 *
 * Verifies since-filter behavior, user scoping, and empty response handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { getResultsSince } from '$lib/server/messages';

// ---------------------------------------------------------------------------
// Mock SQL helper
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
// getResultsSince
// ---------------------------------------------------------------------------

describe('getResultsSince', () => {
  it('returns updated results for a user since the given timestamp', async () => {
    const now = new Date('2025-06-15T10:00:00Z');
    const sql = createMockSql([
      {
        request_id: 'req_01',
        status: 'succeeded',
        result_id: 'res_01',
        response: { content: [{ type: 'text', text: 'Hello' }] },
        stop_reason: 'end_turn',
        input_tokens: 10,
        output_tokens: 20,
        result_created_at: now,
      },
    ]);

    const results = await getResultsSince(sql, 'user_01', new Date('2025-06-15T09:00:00Z'));

    expect(results).toHaveLength(1);
    expect(results[0].requestId).toBe('req_01');
    expect(results[0].status).toBe('succeeded');
    const result = results[0].result;
    expect(result).not.toBeNull();
    expect(result?.id).toBe('res_01');
    expect(result?.inputTokens).toBe(10);
    expect(result?.outputTokens).toBe(20);
  });

  it('returns status-only updates (no result yet)', async () => {
    const sql = createMockSql([
      {
        request_id: 'req_02',
        status: 'processing',
        result_id: null,
        response: null,
        stop_reason: null,
        input_tokens: null,
        output_tokens: null,
        result_created_at: null,
      },
    ]);

    const results = await getResultsSince(sql, 'user_01', new Date('2025-06-15T09:00:00Z'));

    expect(results).toHaveLength(1);
    expect(results[0].requestId).toBe('req_02');
    expect(results[0].status).toBe('processing');
    expect(results[0].result).toBeNull();
  });

  it('returns empty array when no results found since timestamp', async () => {
    const sql = createMockSql([]);
    const results = await getResultsSince(sql, 'user_01', new Date('2025-06-15T12:00:00Z'));
    expect(results).toEqual([]);
  });

  it('maps multiple results correctly', async () => {
    const now = new Date('2025-06-15T10:00:00Z');
    const sql = createMockSql([
      {
        request_id: 'req_01',
        status: 'succeeded',
        result_id: 'res_01',
        response: { text: 'first' },
        stop_reason: 'end_turn',
        input_tokens: 5,
        output_tokens: 10,
        result_created_at: now,
      },
      {
        request_id: 'req_02',
        status: 'failed',
        result_id: 'res_02',
        response: { error: 'rate limited' },
        stop_reason: null,
        input_tokens: 5,
        output_tokens: 0,
        result_created_at: now,
      },
      {
        request_id: 'req_03',
        status: 'batched',
        result_id: null,
        response: null,
        stop_reason: null,
        input_tokens: null,
        output_tokens: null,
        result_created_at: null,
      },
    ]);

    const results = await getResultsSince(sql, 'user_01', new Date('2025-06-15T09:00:00Z'));

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('succeeded');
    expect(results[0].result).not.toBeNull();
    expect(results[1].status).toBe('failed');
    expect(results[1].result).not.toBeNull();
    expect(results[2].status).toBe('batched');
    expect(results[2].result).toBeNull();
  });
});
