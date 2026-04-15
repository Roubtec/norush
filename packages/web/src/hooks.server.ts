/**
 * SvelteKit server hooks.
 *
 * 1. Verifies database connectivity lazily on the first request (with retry backoff).
 * 2. Validates the WorkOS session cookie and populates `locals.user`.
 *    In development, `NORUSH_DEV_AUTH_BYPASS=1` skips WorkOS entirely and
 *    authenticates every request as a synthetic dev user.
 */

import type { Handle } from '@sveltejs/kit';
import { getSql } from '$lib/server/norush';
import { validateSession, SESSION_COOKIE } from '$lib/server/auth';
import { provisionUser } from '$lib/server/user';

let dbInitialized = false;
let nextInitializationAttemptAt = 0;
const INITIALIZATION_RETRY_DELAY_MS = 60_000;

// Dev-only auth bypass. Hard-gated on NODE_ENV so a misconfigured production
// deploy cannot silently grant unauthenticated access.
const DEV_AUTH_BYPASS =
  process.env.NORUSH_DEV_AUTH_BYPASS === '1' &&
  (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test');

const DEV_USER = {
  id: 'dev-user',
  email: 'dev@localhost',
  firstName: 'Dev',
  lastName: 'User',
  sessionId: 'dev-session',
} as const;

let devAuthWarned = false;
let devUserProvisioned = false;

export const handle: Handle = async ({ event, resolve }) => {
  // -- Database init (once, with retry backoff) -----------------------------
  const now = Date.now();

  if (!dbInitialized && process.env.DATABASE_URL && now >= nextInitializationAttemptAt) {
    try {
      const db = getSql();
      await db`SELECT 1`;
      dbInitialized = true;
      console.log('[norush] Database connection verified');
    } catch (err) {
      nextInitializationAttemptAt = Date.now() + INITIALIZATION_RETRY_DELAY_MS;
      console.error('[norush] Database connection failed, retrying in 60s:', err);
    }
  }

  // -- Session validation --------------------------------------------------
  // Skip auth for API routes that use token-based auth instead of session cookies.
  const publicPrefixes = ['/api/v1/'];
  const isPublic = publicPrefixes.some((p) => event.url.pathname.startsWith(p));

  if (DEV_AUTH_BYPASS) {
    if (!devAuthWarned) {
      console.warn(
        '[norush] NORUSH_DEV_AUTH_BYPASS=1 — all requests authenticated as ' +
          "'dev-user'. Do NOT use in production.",
      );
      devAuthWarned = true;
    }
    event.locals.user = { ...DEV_USER };

    // Ensure the dev user has a row in `users`/`user_settings` so foreign-key
    // joins in (app) routes succeed. Idempotent — runs once per process.
    if (!devUserProvisioned && dbInitialized) {
      try {
        await provisionUser(getSql(), {
          workosId: DEV_USER.id,
          email: DEV_USER.email,
          firstName: DEV_USER.firstName,
          lastName: DEV_USER.lastName,
        });
        devUserProvisioned = true;
      } catch (err) {
        console.error('[norush] Dev user provisioning failed:', err);
      }
    }
  } else if (!isPublic) {
    // Validate the session cookie so `locals.user` is available on all
    // non-API routes, including /login (for the "already authenticated"
    // redirect) and /auth/logout (for WorkOS session revocation).
    // Access control (redirect to /login) is enforced in the (app) layout, not here.
    const sessionData = event.cookies.get(SESSION_COOKIE);
    if (sessionData) {
      try {
        const session = await validateSession(sessionData);
        if (session.authenticated) {
          event.locals.user = {
            id: session.user.workosId,
            email: session.user.email,
            firstName: session.user.firstName,
            lastName: session.user.lastName,
            sessionId: session.sessionId,
          };
        } else {
          // Invalid or expired session — clear the stale cookie to avoid
          // repeated WorkOS calls on every subsequent request.
          event.cookies.delete(SESSION_COOKIE, { path: '/' });
        }
      } catch {
        // Malformed cookie — clear it so the user isn't stuck in a loop.
        event.cookies.delete(SESSION_COOKIE, { path: '/' });
      }
    }
  }

  return resolve(event);
};
