/**
 * GET /auth/callback
 *
 * WorkOS AuthKit redirects here after a successful login or signup.
 * Exchanges the authorization code for a sealed session, provisions the
 * user in the database, and sets the session cookie.
 */

import { redirect, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { exchangeCodeForSession, SESSION_COOKIE, COOKIE_OPTIONS } from '$lib/server/auth';
import { provisionUser } from '$lib/server/user';
import { getSql } from '$lib/server/norush';
import { sanitizeNextPath, NEXT_COOKIE, NEXT_COOKIE_OPTIONS } from '$lib/server/redirect';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  if (!code) {
    return error(400, 'Missing authorization code');
  }

  // Read and clear the post-login redirect cookie up-front; re-sanitize it
  // since cookies are user-controlled and could have been tampered with.
  const nextPath = sanitizeNextPath(cookies.get(NEXT_COOKIE));
  cookies.delete(NEXT_COOKIE, { path: NEXT_COOKIE_OPTIONS.path });

  try {
    const { user, sealedSession } = await exchangeCodeForSession(code);

    // Provision user in database (idempotent).
    if (env.DATABASE_URL) {
      const sql = getSql();
      await provisionUser(sql, {
        workosId: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      });
    }

    // Set the sealed session cookie.
    cookies.set(SESSION_COOKIE, sealedSession, COOKIE_OPTIONS);
  } catch (err) {
    console.error('[auth/callback] Authentication failed:', err);
    return error(500, 'Authentication failed');
  }

  redirect(302, nextPath ?? '/');
};
