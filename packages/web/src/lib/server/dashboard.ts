/**
 * Server-side dashboard query helpers.
 *
 * Queries the `requests`, `results`, and `batches` tables directly via
 * postgres.js to produce aggregated usage stats. All queries are scoped
 * to the authenticated user.
 */

import type postgres from "postgres";
import {
  standardCost,
  batchCost,
  type CostBreakdownEntry,
  type DetailedUsageStats,
} from "@norush/core";

/** Serializable dashboard stats (same shape as DetailedUsageStats). */
export type DashboardStats = DetailedUsageStats;

/**
 * Fetch detailed usage stats for a user within a date range.
 *
 * Runs three SQL queries in parallel:
 * 1. Per-provider/model aggregation with request counts and token sums.
 * 2. Average batch turnaround time for completed batches.
 * 3. Distinct batch count (avoids double-counting batches spanning multiple models).
 *
 * Cost calculations use the shared pricing module from @norush/core.
 */
export async function getDetailedStatsFromDb(
  sql: postgres.Sql,
  userId: string,
  period: { from: Date; to: Date },
): Promise<DashboardStats> {
  const [breakdownRows, turnaroundRows, batchCountRows] = await Promise.all([
    // Per-provider/model breakdown with request status counts.
    sql`
      SELECT
        r.provider,
        r.model,
        COUNT(*)::int AS request_count,
        COUNT(*) FILTER (WHERE r.status = 'succeeded')::int AS succeeded_count,
        COUNT(*) FILTER (WHERE r.status IN ('failed', 'failed_final'))::int AS failed_count,
        COALESCE(SUM(res.input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(res.output_tokens), 0)::int AS output_tokens
      FROM requests r
      LEFT JOIN results res ON res.request_id = r.id
      WHERE r.user_id = ${userId}
        AND r.created_at >= ${period.from}
        AND r.created_at <= ${period.to}
      GROUP BY r.provider, r.model
      ORDER BY r.provider, r.model
    `,

    // Average batch turnaround for completed batches owned by this user.
    sql`
      SELECT
        AVG(EXTRACT(EPOCH FROM (b.ended_at - b.submitted_at)) * 1000)::double precision AS avg_turnaround_ms
      FROM batches b
      WHERE b.submitted_at IS NOT NULL
        AND b.ended_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM requests r
          WHERE r.batch_id = b.id
            AND r.user_id = ${userId}
            AND r.created_at >= ${period.from}
            AND r.created_at <= ${period.to}
        )
    `,

    // Count distinct batches across all provider/model groups to avoid double-counting
    // batches that contain requests for multiple models.
    sql`
      SELECT COUNT(DISTINCT r.batch_id)::int AS total_batches
      FROM requests r
      WHERE r.user_id = ${userId}
        AND r.created_at >= ${period.from}
        AND r.created_at <= ${period.to}
        AND r.batch_id IS NOT NULL
    `,
  ]);

  // Aggregate totals across all groups.
  let totalRequests = 0;
  let succeededRequests = 0;
  let failedRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const costBreakdown: CostBreakdownEntry[] = breakdownRows.map((row) => {
    const provider = row.provider as string;
    const model = row.model as string;
    const inputTokens = (row.input_tokens as number) ?? 0;
    const outputTokens = (row.output_tokens as number) ?? 0;
    const requestCount = (row.request_count as number) ?? 0;
    const succeeded = (row.succeeded_count as number) ?? 0;
    const failed = (row.failed_count as number) ?? 0;

    totalRequests += requestCount;
    succeededRequests += succeeded;
    failedRequests += failed;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    return {
      provider: provider as CostBreakdownEntry["provider"],
      model,
      inputTokens,
      outputTokens,
      batchCostUsd: batchCost(provider, inputTokens, outputTokens),
      standardCostUsd: standardCost(provider, inputTokens, outputTokens),
      requestCount,
    };
  });

  const turnaroundRow = turnaroundRows[0] as Record<string, unknown> | undefined;
  const avgTurnaroundMs =
    turnaroundRow?.avg_turnaround_ms != null
      ? Number(turnaroundRow.avg_turnaround_ms)
      : null;

  const totalStandardCostUsd = costBreakdown.reduce(
    (s, e) => s + e.standardCostUsd,
    0,
  );
  const totalBatchCostUsd = costBreakdown.reduce(
    (s, e) => s + e.batchCostUsd,
    0,
  );

  const batchCountRow = batchCountRows[0] as Record<string, unknown> | undefined;
  const totalBatches = batchCountRow?.total_batches != null
    ? (batchCountRow.total_batches as number)
    : 0;

  return {
    totalRequests,
    succeededRequests,
    failedRequests,
    totalInputTokens,
    totalOutputTokens,
    totalBatches,
    costBreakdown,
    avgTurnaroundMs,
    totalBatchCostUsd,
    totalStandardCostUsd,
    totalSavingsUsd: totalStandardCostUsd - totalBatchCostUsd,
  };
}
