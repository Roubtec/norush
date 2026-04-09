/**
 * GET /api/v1/batches — List the authenticated user's batches (paginated).
 *
 * Batches are linked to users through the requests table.
 * Authentication: Bearer token in Authorization header.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getSql } from "$lib/server/norush";
import { authenticateApiRequest } from "$lib/server/api-auth";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function apiError(code: string, message: string, status: number) {
  return json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// GET — list batches
// ---------------------------------------------------------------------------

export const GET: RequestHandler = async ({ request, url }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get("authorization"));
  if (!caller) {
    return apiError("unauthorized", "Invalid or missing API token", 401);
  }

  // Parse pagination
  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const parsedLimit = parseInt(limitParam ?? "50", 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 100);

  // Find batches that contain at least one request from this user.
  // Use a subquery for user scoping since batches don't have a direct user_id.
  const rows = await sql`
    SELECT DISTINCT ON (b.id)
      b.id, b.provider, b.status, b.request_count,
      b.succeeded_count, b.failed_count,
      b.submitted_at, b.ended_at,
      b.created_at, b.updated_at
    FROM batches b
    INNER JOIN requests r ON r.batch_id = b.id
    WHERE r.user_id = ${caller.userId}
      ${cursor ? sql`AND b.id < ${cursor}` : sql``}
    ORDER BY b.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const batches = pageRows.map((row) => ({
    id: row.id as string,
    provider: row.provider as string,
    status: row.status as string,
    requestCount: row.request_count as number,
    succeededCount: row.succeeded_count as number,
    failedCount: row.failed_count as number,
    submittedAt: row.submitted_at ? (row.submitted_at as Date).toISOString() : null,
    endedAt: row.ended_at ? (row.ended_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }));

  const nextCursor = hasMore && pageRows.length > 0
    ? (pageRows[pageRows.length - 1].id as string)
    : null;

  return json({
    batches,
    pagination: {
      cursor: nextCursor,
      hasMore,
      limit,
    },
  });
};
