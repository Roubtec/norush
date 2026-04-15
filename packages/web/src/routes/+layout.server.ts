/**
 * Root layout server load.
 *
 * Exposes a serializable view of `locals.user` (or null) on every page so the
 * site header can decide whether to render the primary navigation and the
 * logout link. Auth enforcement still lives in `(app)/+layout.server.ts`.
 */

import type { LayoutServerLoad } from './$types';
import { toPublicUser } from '$lib/server/user';

export const load: LayoutServerLoad = async ({ locals }) => {
  return { user: toPublicUser(locals.user) };
};
