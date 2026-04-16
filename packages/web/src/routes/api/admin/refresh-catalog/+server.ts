/**
 * POST /api/admin/refresh-catalog — Manually trigger a provider catalog refresh.
 *
 * Returns 204 on success, 500 on failure. Authentication reuses the
 * existing bearer-token gate (`authenticateApiRequest`) — there is no
 * standalone "admin" user table in this codebase yet, so any authenticated
 * API token can trigger a refresh. The operation is read-mostly and only
 * writes to `provider_catalog` (a non-user-scoped table), so the risk of
 * letting authenticated callers trigger it is low; the bigger concern is
 * unauthenticated access, which this gate blocks.
 *
 * This endpoint sits deliberately under `/api/admin/` rather than
 * `/api/v1/` so a future "operator only" gate can be layered on without a
 * path break.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSql, getEngine, getStore } from '$lib/server/norush';
import { authenticateApiRequest } from '$lib/server/api-auth';
import { refreshProviderCatalog } from '$lib/server/catalog';

function apiError(code: string, message: string, status: number, detail?: unknown) {
  return json({ error: { code, message, detail } }, { status });
}

export const POST: RequestHandler = async ({ request }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get('authorization'));
  if (!caller) {
    return apiError('unauthorized', 'Invalid or missing API token', 401);
  }

  // Ensure the engine is initialized so `getStore()` is safe to call.
  await getEngine();
  const store = getStore();

  try {
    const results = await refreshProviderCatalog(store);
    const hadError = results.some((r) => r.skipped?.startsWith('error:'));
    if (hadError) {
      return apiError('refresh_failed', 'One or more providers failed to refresh', 500, results);
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return apiError(
      'refresh_failed',
      err instanceof Error ? err.message : 'Catalog refresh threw',
      500,
    );
  }
};
