/**
 * SvelteKit server hooks.
 *
 * 1. Verifies database connectivity lazily on the first request (with retry backoff).
 * 2. Validates the WorkOS session cookie and populates `locals.user`.
 */

import type { Handle } from "@sveltejs/kit";
import { getSql } from "$lib/server/norush";
import { validateSession, SESSION_COOKIE } from "$lib/server/auth";

let dbInitialized = false;
let nextInitializationAttemptAt = 0;
const INITIALIZATION_RETRY_DELAY_MS = 60_000;

export const handle: Handle = async ({ event, resolve }) => {
  // -- Database init (once, with retry backoff) -----------------------------
  const now = Date.now();

  if (
    !dbInitialized &&
    process.env.DATABASE_URL &&
    now >= nextInitializationAttemptAt
  ) {
    try {
      const db = getSql();
      await db`SELECT 1`;
      dbInitialized = true;
      console.log("[norush] Database connection verified");
    } catch (err) {
      nextInitializationAttemptAt = Date.now() + INITIALIZATION_RETRY_DELAY_MS;
      console.error("[norush] Database connection failed, retrying in 60s:", err);
    }
  }

  // -- Session validation --------------------------------------------------
  // Validate the session cookie on every request so `locals.user` is
  // available on all routes, including /login (for the "already authenticated"
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
        event.cookies.delete(SESSION_COOKIE, { path: "/" });
      }
    } catch {
      // Malformed cookie — clear it so the user isn't stuck in a loop.
      event.cookies.delete(SESSION_COOKIE, { path: "/" });
    }
  }

  return resolve(event);
};
