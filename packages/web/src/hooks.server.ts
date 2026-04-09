/**
 * SvelteKit server hooks.
 *
 * Initializes the PostgresStore and norush engine lazily on the first request.
 * Future hooks (auth, rate limiting) will be added in subsequent tasks.
 */

import type { Handle } from "@sveltejs/kit";
import { getSql } from "$lib/server/norush";

let initialized = false;

export const handle: Handle = async ({ event, resolve }) => {
  if (!initialized && process.env.DATABASE_URL) {
    try {
      const db = getSql();
      await db`SELECT 1`;
      initialized = true;
      console.log("[norush] Database connection verified");
    } catch (err) {
      console.error("[norush] Database connection failed:", err);
    }
  }

  return resolve(event);
};
