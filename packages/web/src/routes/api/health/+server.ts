/**
 * GET /api/health
 *
 * Returns 200 if the database is reachable, 503 otherwise.
 * Used by Azure Container Apps health probes and monitoring.
 */

import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getSql } from "$lib/server/norush";

export const GET: RequestHandler = async () => {
  // If DATABASE_URL is not set, return healthy with a warning
  if (!process.env.DATABASE_URL) {
    return json({
      status: "ok",
      database: "unconfigured",
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const sql = getSql();
    await sql`SELECT 1`;

    return json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw error(503, {
      message: `Database unreachable: ${message}`,
    });
  }
};
