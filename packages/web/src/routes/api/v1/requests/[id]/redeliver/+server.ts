/**
 * POST /api/v1/requests/:id/redeliver — Re-trigger webhook delivery.
 *
 * Resets the delivery status to `pending` and delivery attempts to 0
 * so the delivery worker picks it up again.
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
// POST — re-deliver
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ params, request }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get('authorization'));
  if (!caller) {
    return apiError('unauthorized', 'Invalid or missing API token', 401);
  }

  const { id } = params;

  // Verify the request belongs to this user and has a result.
  const rows = await sql`
    SELECT
      r.id AS request_id,
      r.callback_url,
      res.id AS result_id,
      res.delivery_status
    FROM requests r
    LEFT JOIN results res ON res.request_id = r.id
    WHERE r.id = ${id} AND r.user_id = ${caller.userId}
  `;

  if (rows.length === 0) {
    return apiError('not_found', 'Request not found', 404);
  }

  const row = rows[0];

  if (!row.result_id) {
    return apiError(
      'no_result',
      'This request does not have a result yet. Re-delivery is only available for completed requests.',
      409,
    );
  }

  if (!row.callback_url) {
    return apiError(
      'no_callback_url',
      'This request does not have a callback URL configured. Re-delivery requires a callback URL.',
      409,
    );
  }

  // Reset delivery state so the delivery worker picks it up.
  await sql`
    UPDATE results
    SET
      delivery_status = 'pending',
      delivery_attempts = 0,
      last_delivery_error = NULL,
      next_delivery_at = NULL,
      delivered_at = NULL
    WHERE id = ${row.result_id as string}
  `;

  return json({
    message: 'Re-delivery scheduled',
    requestId: id,
    resultId: row.result_id as string,
    previousDeliveryStatus: row.delivery_status as string,
  });
};
