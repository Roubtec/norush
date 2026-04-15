/**
 * POST /api/v1/flush — Manually trigger a batch flush.
 *
 * Forces the engine to flush the request queue immediately,
 * forming and submitting any pending batches.
 *
 * Authentication: Bearer token in Authorization header.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSql, getEngine } from '$lib/server/norush';
import { authenticateApiRequest } from '$lib/server/api-auth';

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function apiError(code: string, message: string, status: number) {
  return json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// POST — manual flush
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get('authorization'));
  if (!caller) {
    return apiError('unauthorized', 'Invalid or missing API token', 401);
  }

  const engine = await getEngine();
  await engine.flush();

  return json({
    message: 'Flush triggered successfully',
    flushedAt: new Date().toISOString(),
  });
};
