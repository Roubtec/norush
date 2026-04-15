/**
 * GET /api/v1/requests/:id — Get a single request with its result.
 *
 * Authentication: Bearer token in Authorization header.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSql } from '$lib/server/norush';
import { authenticateApiRequest } from '$lib/server/api-auth';

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function apiError(code: string, message: string, status: number) {
  return json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// GET — single request with result
// ---------------------------------------------------------------------------

export const GET: RequestHandler = async ({ params, request }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get('authorization'));
  if (!caller) {
    return apiError('unauthorized', 'Invalid or missing API token', 401);
  }

  const { id } = params;

  const rows = await sql`
    SELECT
      r.id, r.provider, r.model, r.params, r.status,
      r.batch_id, r.callback_url, r.retry_count, r.max_retries,
      r.created_at AS request_created_at,
      r.updated_at AS request_updated_at,
      res.id AS result_id,
      res.response,
      res.stop_reason,
      res.input_tokens,
      res.output_tokens,
      res.delivery_status,
      res.created_at AS result_created_at
    FROM requests r
    LEFT JOIN results res ON res.request_id = r.id
    WHERE r.id = ${id} AND r.user_id = ${caller.userId}
  `;

  if (rows.length === 0) {
    return apiError('not_found', 'Request not found', 404);
  }

  const row = rows[0];

  const result = row.result_id
    ? {
        id: row.result_id as string,
        response: row.response as Record<string, unknown>,
        stopReason: (row.stop_reason as string) ?? null,
        inputTokens: (row.input_tokens as number) ?? null,
        outputTokens: (row.output_tokens as number) ?? null,
        deliveryStatus: row.delivery_status as string,
        createdAt: (row.result_created_at as Date).toISOString(),
      }
    : null;

  return json({
    request: {
      id: row.id as string,
      provider: row.provider as string,
      model: row.model as string,
      params: row.params as Record<string, unknown>,
      status: row.status as string,
      batchId: (row.batch_id as string) ?? null,
      callbackUrl: (row.callback_url as string) ?? null,
      retryCount: row.retry_count as number,
      maxRetries: row.max_retries as number,
      createdAt: (row.request_created_at as Date).toISOString(),
      updatedAt: (row.request_updated_at as Date).toISOString(),
      result,
    },
  });
};
