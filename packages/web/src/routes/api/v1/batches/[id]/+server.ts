/**
 * GET /api/v1/batches/:id — Get a single batch with request summary.
 *
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
// GET — single batch with request summary
// ---------------------------------------------------------------------------

export const GET: RequestHandler = async ({ params, request }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get("authorization"));
  if (!caller) {
    return apiError("unauthorized", "Invalid or missing API token", 401);
  }

  const { id } = params;

  // Verify the batch exists and the user has at least one request in it.
  const batchRows = await sql`
    SELECT
      b.id, b.provider, b.provider_batch_id, b.status,
      b.request_count, b.succeeded_count, b.failed_count,
      b.submission_attempts, b.polling_strategy,
      b.submitted_at, b.ended_at,
      b.created_at, b.updated_at
    FROM batches b
    WHERE b.id = ${id}
      AND EXISTS (
        SELECT 1 FROM requests r
        WHERE r.batch_id = b.id AND r.user_id = ${caller.userId}
      )
  `;

  if (batchRows.length === 0) {
    return apiError("not_found", "Batch not found", 404);
  }

  const row = batchRows[0];

  // Get a summary of request statuses within this batch for this user.
  const summaryRows = await sql`
    SELECT status, COUNT(*)::int AS count
    FROM requests
    WHERE batch_id = ${id} AND user_id = ${caller.userId}
    GROUP BY status
  `;

  const requestSummary: Record<string, number> = {};
  for (const s of summaryRows) {
    requestSummary[s.status as string] = s.count as number;
  }

  return json({
    batch: {
      id: row.id as string,
      provider: row.provider as string,
      providerBatchId: (row.provider_batch_id as string) ?? null,
      status: row.status as string,
      requestCount: row.request_count as number,
      succeededCount: row.succeeded_count as number,
      failedCount: row.failed_count as number,
      submissionAttempts: row.submission_attempts as number,
      pollingStrategy: (row.polling_strategy as string) ?? null,
      submittedAt: row.submitted_at ? (row.submitted_at as Date).toISOString() : null,
      endedAt: row.ended_at ? (row.ended_at as Date).toISOString() : null,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
      requestSummary,
    },
  });
};
