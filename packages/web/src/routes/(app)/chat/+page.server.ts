/**
 * Server load for the chat page.
 *
 * Fetches the user's messages with results on initial page load and the
 * current provider catalog so the Composer + savings calculations use
 * server-fetched rates and lifecycle metadata.
 * Subsequent updates arrive via client-side polling of /api/results.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSql, getEngine, getStore } from '$lib/server/norush';
import { listMessages } from '$lib/server/messages';
import { listAvailableModels, type AvailableModel } from '$lib/server/catalog';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    redirect(302, '/login');
  }

  const sql = getSql();

  // Capture cursor before the query so any updates landing during the SELECT
  // are included in the first poll window (avoids a race between DB snapshot
  // and timestamp generation).
  const loadedAt = new Date().toISOString();

  let messages: Awaited<ReturnType<typeof listMessages>> = [];
  let loadError: string | null = null;

  try {
    messages = await listMessages(sql, locals.user.id, { limit: 50 });
  } catch (err) {
    console.error('[chat] Failed to load messages:', err);
    loadError = 'Failed to load messages. Please try again.';
  }

  // Load the provider catalog so the Composer can render per-model
  // lifecycle hints and the savings calculation can use live per-model
  // rates. On error we fall back to the hardcoded seed inside
  // listAvailableModels — a broken DB here should not block the chat UI.
  let catalog: AvailableModel[] = [];
  try {
    await getEngine();
    catalog = await listAvailableModels(getStore());
  } catch (err) {
    console.error('[chat] Failed to load provider catalog:', err);
  }

  return {
    messages,
    loadError,
    loadedAt,
    catalog,
  };
};
