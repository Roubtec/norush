/**
 * Protected layout server load.
 *
 * All routes under the (app) group require authentication.
 * If the user is not logged in, redirect to /login.
 */

import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.user) {
    redirect(302, '/login');
  }

  return {
    user: {
      id: locals.user.id,
      email: locals.user.email,
      firstName: locals.user.firstName,
      lastName: locals.user.lastName,
    },
  };
};
