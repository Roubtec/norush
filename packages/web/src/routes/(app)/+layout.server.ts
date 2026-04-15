/**
 * Protected layout server load.
 *
 * All routes under the (app) group require authentication.
 * If the user is not logged in, redirect to /login.
 */

import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { sanitizeNextPath } from '$lib/server/redirect';
import { toPublicUser } from '$lib/server/user';

export const load: LayoutServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    // Preserve where the user was trying to go so /auth/callback can return
    // them there after sign-in. Sanitizer rejects /login and /auth/* so
    // there's no risk of a redirect loop.
    const next = sanitizeNextPath(url.pathname + url.search);
    const target = next ? `/login?next=${encodeURIComponent(next)}` : '/login';
    redirect(302, target);
  }

  return { user: toPublicUser(locals.user) };
};
