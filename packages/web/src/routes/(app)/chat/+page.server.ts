/**
 * Server load for the chat page.
 *
 * Fetches the user's messages with results on initial page load.
 * Subsequent updates arrive via client-side polling of /api/results.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSql } from '$lib/server/norush';
import { listMessages } from '$lib/server/messages';

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

  return {
    messages,
    loadError,
    loadedAt,
  };
};
