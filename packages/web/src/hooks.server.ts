/**
 * SvelteKit server hooks.
 *
 * Verifies database connectivity lazily on the first request.
 * Future hooks (auth, rate limiting) will be added in subsequent tasks.
 */

import type { Handle } from "@sveltejs/kit";
import { getSql } from "$lib/server/norush";

let initialized = false;
let nextInitializationAttemptAt = 0;
const INITIALIZATION_RETRY_DELAY_MS = 60_000;

export const handle: Handle = async ({ event, resolve }) => {
  const now = Date.now();

  if (
    !initialized &&
    process.env.DATABASE_URL &&
    now >= nextInitializationAttemptAt
  ) {
    try {
      const db = getSql();
      await db`SELECT 1`;
      initialized = true;
      console.log("[norush] Database connection verified");
    } catch (err) {
      nextInitializationAttemptAt = Date.now() + INITIALIZATION_RETRY_DELAY_MS;
      console.error("[norush] Database connection failed, retrying in 60s:", err);
    }
  }

  return resolve(event);
};
