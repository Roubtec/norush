/**
 * Server load for the usage dashboard page.
 *
 * Fetches detailed usage stats and spend limits for the authenticated user.
 * Supports a `period` search param: "24h", "7d" (default), or "30d".
 *
 * Note: Uses direct SQL helpers (`getDetailedStatsFromDb`, `getUserLimitsFromDb`)
 * rather than the Store interface. This is intentional — the SvelteKit server
 * routes in this package consistently call `getSql()` directly, and the Store
 * singleton (`getStore()`) requires the engine to be initialised first. The
 * Store's `getDetailedStats()` / `getUserLimits()` implementations contain the
 * same logic and are exercised by the store-contract tests.
 */

import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getSql } from "$lib/server/norush";
import type { UserLimits } from "@norush/core";
import { getDetailedStatsFromDb, type DashboardStats } from "$lib/server/dashboard";

/** Extract authenticated user ID, redirecting to login if absent. */
function requireUser(locals: App.Locals): string {
  if (!locals.user) redirect(302, "/login");
  return locals.user.id;
}

/** Map period string to a DateRange. */
function periodToRange(period: string): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();

  switch (period) {
    case "24h":
      from.setTime(to.getTime() - 24 * 60 * 60 * 1000);
      break;
    case "30d":
      from.setDate(to.getDate() - 30);
      break;
    case "7d":
    default:
      from.setDate(to.getDate() - 7);
      break;
  }

  return { from, to };
}

/**
 * Fetch user limits directly from the database.
 */
async function getUserLimitsFromDb(
  sql: ReturnType<typeof getSql>,
  userId: string,
): Promise<UserLimits | null> {
  const rows = await sql`
    SELECT * FROM user_limits WHERE user_id = ${userId}
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    userId: row.user_id as string,
    maxRequestsPerHour: (row.max_requests_per_hour as number) ?? null,
    maxTokensPerDay: (row.max_tokens_per_day as number) ?? null,
    hardSpendLimitUsd:
      row.hard_spend_limit_usd != null
        ? Number(row.hard_spend_limit_usd)
        : null,
    currentPeriodRequests: (row.current_period_requests as number) ?? 0,
    currentPeriodTokens: (row.current_period_tokens as number) ?? 0,
    currentSpendUsd:
      row.current_spend_usd != null ? Number(row.current_spend_usd) : 0,
    periodResetAt: new Date(row.period_reset_at as string),
    createdAt: new Date(
      (row.created_at as string) ?? (row.updated_at as string),
    ),
    updatedAt: new Date(row.updated_at as string),
  };
}

const VALID_PERIODS = ["24h", "7d", "30d"] as const;
type Period = (typeof VALID_PERIODS)[number];

export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = requireUser(locals);
  const sql = getSql();

  const rawPeriod = url.searchParams.get("period") ?? "7d";
  const period: Period = VALID_PERIODS.includes(rawPeriod as Period)
    ? (rawPeriod as Period)
    : "7d";

  const range = periodToRange(period);

  let stats: DashboardStats | null = null;
  let limits: UserLimits | null = null;
  let loadError: string | null = null;

  try {
    const [s, l] = await Promise.all([
      getDetailedStatsFromDb(sql, userId, range),
      getUserLimitsFromDb(sql, userId),
    ]);
    stats = s;
    limits = l;
  } catch (err) {
    const errorId = new Date().toISOString();
    console.error(`[dashboard] Failed to load stats (${errorId}):`, err);
    loadError =
      `Failed to load usage statistics. Please try again later. Reference: ${errorId}`;
  }

  return {
    period,
    stats: stats ?? {
      totalRequests: 0,
      succeededRequests: 0,
      failedRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalBatches: 0,
      costBreakdown: [],
      avgTurnaroundMs: null,
      totalBatchCostUsd: 0,
      totalStandardCostUsd: 0,
      totalSavingsUsd: 0,
    },
    limits: limits
      ? {
          maxRequestsPerHour: limits.maxRequestsPerHour,
          maxTokensPerDay: limits.maxTokensPerDay,
          hardSpendLimitUsd: limits.hardSpendLimitUsd,
          currentPeriodRequests: limits.currentPeriodRequests,
          currentPeriodTokens: limits.currentPeriodTokens,
          currentSpendUsd: limits.currentSpendUsd,
        }
      : null,
    loadError,
  };
};
