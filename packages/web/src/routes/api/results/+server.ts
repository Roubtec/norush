/**
 * GET /api/results?since={ISO timestamp} — Poll for new results.
 *
 * Returns results delivered after the given timestamp for the current user.
 * The client polls this every 30-60s to pick up completed batch results.
 */

import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getSql } from "$lib/server/norush";
import { getResultsSince } from "$lib/server/messages";

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    error(401, "Authentication required");
  }

  const sinceParam = url.searchParams.get("since");
  if (!sinceParam) {
    return json(
      { error: "Missing required query parameter: since" },
      { status: 400 },
    );
  }

  const since = new Date(sinceParam);
  if (isNaN(since.getTime())) {
    return json(
      { error: "Invalid date format for 'since' parameter" },
      { status: 400 },
    );
  }

  const sql = getSql();
  // Capture cursor before the query so any updates landing during the SELECT
  // are included in the next poll window (avoids a race between DB snapshot
  // and timestamp generation).
  const polledAt = new Date().toISOString();
  const results = await getResultsSince(sql, locals.user.id, since);

  return json({ results, polledAt });
};
