/**
 * Server load for /login.
 *
 * If the user is already authenticated, redirect to the app.
 * Otherwise, generate the WorkOS authorization URL.
 */

import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // Already logged in — go to app.
  if (locals.user) {
    redirect(302, "/");
  }

  // Generate the WorkOS authorization URL. If env vars are missing,
  // return null so the page shows a "not configured" message.
  let authUrl: string | null = null;
  try {
    // Dynamic import to avoid throwing at module load time when env vars
    // are not set (e.g. during build or dev without WorkOS config).
    const { getAuthorizationUrl } = await import("$lib/server/auth");
    authUrl = getAuthorizationUrl();
  } catch {
    // WorkOS not configured — the page will show a fallback message.
  }

  return { authUrl };
};
