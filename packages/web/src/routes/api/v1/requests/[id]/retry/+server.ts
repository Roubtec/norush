/**
 * POST /api/v1/requests/:id/retry — User-triggered re-submission of a failed request.
 *
 * Allows users to manually re-trigger requests that have reached a terminal
 * state (`failed_final` or `canceled`). The request is reset to `queued`
 * with `retry_count: 0` and `batch_id: null`, so the Batch Manager picks it
 * up on the next flush cycle.
 *
 * Constraints:
 * - Only terminal states (`failed_final`, `canceled`) can be retried.
 * - The request must belong to the authenticated user.
 * - Spend limit checks will be enforced by the Batch Manager (task 3-04).
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
// Terminal statuses eligible for retry
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set(['failed_final', 'canceled']);

// ---------------------------------------------------------------------------
// POST — user-triggered retry
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ params, request }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get('authorization'));
  if (!caller) {
    return apiError('unauthorized', 'Invalid or missing API token', 401);
  }

  const { id } = params;

  // Fetch the request, ensuring it belongs to the authenticated user.
  const rows = await sql`
    SELECT id, status, retry_count, batch_id, provider, model
    FROM requests
    WHERE id = ${id} AND user_id = ${caller.userId}
  `;

  if (rows.length === 0) {
    return apiError('not_found', 'Request not found', 404);
  }

  const row = rows[0];
  const currentStatus = row.status as string;

  // Only terminal states can be retried.
  if (!RETRYABLE_STATUSES.has(currentStatus)) {
    return apiError(
      'invalid_state',
      `Request cannot be retried from status '${currentStatus}'. Only requests in 'failed_final' or 'canceled' status can be retried.`,
      400,
    );
  }

  // Reset the request to queued state. The WHERE clause re-checks user_id and
  // status atomically to guard against races (e.g. a concurrent status update
  // between the SELECT above and this UPDATE).
  const updated = await sql`
    UPDATE requests
    SET
      status = 'queued',
      retry_count = 0,
      batch_id = NULL,
      updated_at = now()
    WHERE id = ${id}
      AND user_id = ${caller.userId}
      AND status = ANY(ARRAY['failed_final', 'canceled'])
    RETURNING id
  `;

  if (updated.length === 0) {
    return apiError(
      'conflict',
      'Request status changed before the update could be applied. Please check the current status and try again.',
      409,
    );
  }

  return json({
    message: 'Request re-queued for processing',
    request: {
      id: row.id as string,
      provider: row.provider as string,
      model: row.model as string,
      previousStatus: currentStatus,
      status: 'queued',
      retryCount: 0,
    },
  });
};
