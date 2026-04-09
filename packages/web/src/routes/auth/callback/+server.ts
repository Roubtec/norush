/**
 * GET /auth/callback
 *
 * WorkOS AuthKit redirects here after a successful login or signup.
 * Exchanges the authorization code for a sealed session, provisions the
 * user in the database, and sets the session cookie.
 */

import { redirect, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  exchangeCodeForSession,
  SESSION_COOKIE,
  COOKIE_OPTIONS,
} from "$lib/server/auth";
import { provisionUser } from "$lib/server/user";
import { getSql } from "$lib/server/norush";

export const GET: RequestHandler = async ({ url, cookies }) => {
  const code = url.searchParams.get("code");
  if (!code) {
    return error(400, "Missing authorization code");
  }

  try {
    const { user, sealedSession } = await exchangeCodeForSession(code);

    // Provision user in database (idempotent).
    if (process.env.DATABASE_URL) {
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
    console.error("[auth/callback] Authentication failed:", err);
    return error(500, "Authentication failed");
  }

  // Redirect to the app home page.
  redirect(302, "/");
};
