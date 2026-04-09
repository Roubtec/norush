/**
 * GET /auth/logout
 *
 * Clears the session cookie and redirects to the WorkOS logout URL,
 * which in turn redirects the user back to /login.
 */

import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getLogoutUrl, SESSION_COOKIE } from "$lib/server/auth";

export const GET: RequestHandler = async ({ locals, cookies }) => {
  const sessionId = locals.user?.sessionId;

  // Clear the session cookie regardless.
  cookies.delete(SESSION_COOKIE, { path: "/" });

  if (sessionId) {
    // Redirect to WorkOS to revoke the session server-side.
    const logoutUrl = getLogoutUrl(sessionId);
    redirect(302, logoutUrl);
  }

  // No active session — just go to login.
  redirect(302, "/login");
};
