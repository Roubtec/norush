/**
 * Server load for /login.
 *
 * If the user is already authenticated, redirect to the app.
 * Otherwise, generate the WorkOS authorization URL.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sanitizeNextPath, NEXT_COOKIE, NEXT_COOKIE_OPTIONS } from '$lib/server/redirect';

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
  const next = sanitizeNextPath(url.searchParams.get('next'));

  // Already logged in — honour ?next=, otherwise go home.
  if (locals.user) {
    redirect(302, next ?? '/');
  }

  // Stash the desired post-login destination in a short-lived cookie so it
  // survives the WorkOS round-trip (which discards our query string).
  if (next) {
    cookies.set(NEXT_COOKIE, next, NEXT_COOKIE_OPTIONS);
  } else {
    cookies.delete(NEXT_COOKIE, { path: NEXT_COOKIE_OPTIONS.path });
  }

  // Generate the WorkOS authorization URL. If env vars are missing,
  // return null so the page shows a "not configured" message.
  let authUrl: string | null = null;
  try {
    // Dynamic import to avoid throwing at module load time when env vars
    // are not set (e.g. during build or dev without WorkOS config).
    const { getAuthorizationUrl } = await import('$lib/server/auth');
    authUrl = getAuthorizationUrl();
  } catch {
    // WorkOS not configured — the page will show a fallback message.
  }

  return { authUrl };
};
