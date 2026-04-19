/**
 * Server load for /register.
 *
 * Mirrors /login but requests the sign-up screen from WorkOS AuthKit via
 * `screenHint: 'sign-up'`. Already-authenticated users are redirected away.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sanitizeNextPath, NEXT_COOKIE, NEXT_COOKIE_OPTIONS } from '$lib/server/redirect';

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
  const next = sanitizeNextPath(url.searchParams.get('next'));

  if (locals.user) {
    redirect(302, next ?? '/');
  }

  if (next) {
    cookies.set(NEXT_COOKIE, next, NEXT_COOKIE_OPTIONS);
  } else {
    cookies.delete(NEXT_COOKIE, { path: NEXT_COOKIE_OPTIONS.path });
  }

  let authUrl: string | null = null;
  try {
    const { getAuthorizationUrl } = await import('$lib/server/auth');
    authUrl = getAuthorizationUrl('sign-up');
  } catch {
    // WorkOS not configured — the page will show a fallback message.
  }

  return { authUrl };
};
