/**
 * Server load and form actions for the spend limit settings page.
 *
 * - load: Fetches the user's current limits.
 * - update: Validates and updates the user's spend limits.
 */

import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getSql } from "$lib/server/norush";
import type { UserLimits } from "@norush/core";

/** Extract authenticated user ID, redirecting to login if absent. */
function requireUser(locals: App.Locals): string {
  if (!locals.user) redirect(302, "/login");
  return locals.user.id;
}

/**
 * Fetch user limits directly from the database.
 * We use raw SQL here since the Store instance requires the engine to be initialized.
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
    maxTokensPerPeriod: (row.max_tokens_per_period as number) ?? null,
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

export const load: PageServerLoad = async ({ locals }) => {
  const userId = requireUser(locals);
  const sql = getSql();

  let limits: UserLimits | null = null;
  let loadError: string | null = null;

  try {
    limits = await getUserLimitsFromDb(sql, userId);
  } catch (err) {
    console.error("[settings/limits] Failed to load user limits:", err);
    loadError =
      "Failed to load spend limits. The database table may not exist yet.";
  }

  return {
    limits: limits
      ? {
          maxRequestsPerHour: limits.maxRequestsPerHour,
          maxTokensPerPeriod: limits.maxTokensPerPeriod,
          hardSpendLimitUsd: limits.hardSpendLimitUsd,
          currentPeriodRequests: limits.currentPeriodRequests,
          currentPeriodTokens: limits.currentPeriodTokens,
          currentSpendUsd: limits.currentSpendUsd,
          periodResetAt: limits.periodResetAt.toISOString(),
        }
      : null,
    loadError,
  };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationError {
  field: string;
  message: string;
}

function parseOptionalInt(
  value: string | null,
): number | null | undefined {
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n !== n) return undefined; // signals invalid; rejects "1.5", "abc"
  return n;
}

function parseOptionalFloat(
  value: string | null,
): number | null | undefined {
  if (value === null || value === "") return null;
  const n = parseFloat(value);
  if (isNaN(n)) return undefined;
  return n;
}

export const actions = {
  update: async ({ request, locals }) => {
    const userId = requireUser(locals);
    const sql = getSql();
    const data = await request.formData();

    const errors: ValidationError[] = [];

    const maxRequestsPerHourRaw = data.get(
      "maxRequestsPerHour",
    ) as string | null;
    const maxTokensPerPeriodRaw = data.get("maxTokensPerPeriod") as string | null;
    const hardSpendLimitUsdRaw = data.get(
      "hardSpendLimitUsd",
    ) as string | null;

    const maxRequestsPerHour = parseOptionalInt(maxRequestsPerHourRaw);
    const maxTokensPerPeriod = parseOptionalInt(maxTokensPerPeriodRaw);
    const hardSpendLimitUsd = parseOptionalFloat(hardSpendLimitUsdRaw);

    if (maxRequestsPerHour === undefined) {
      errors.push({
        field: "maxRequestsPerHour",
        message: "Must be a valid number or empty for unlimited",
      });
    } else if (maxRequestsPerHour !== null && maxRequestsPerHour < 1) {
      errors.push({
        field: "maxRequestsPerHour",
        message: "Must be at least 1",
      });
    }

    if (maxTokensPerPeriod === undefined) {
      errors.push({
        field: "maxTokensPerPeriod",
        message: "Must be a valid number or empty for unlimited",
      });
    } else if (maxTokensPerPeriod !== null && maxTokensPerPeriod < 1) {
      errors.push({
        field: "maxTokensPerPeriod",
        message: "Must be at least 1",
      });
    }

    if (hardSpendLimitUsd === undefined) {
      errors.push({
        field: "hardSpendLimitUsd",
        message: "Must be a valid number or empty for unlimited",
      });
    } else if (hardSpendLimitUsd !== null && hardSpendLimitUsd < 0) {
      errors.push({
        field: "hardSpendLimitUsd",
        message: "Must be zero or positive",
      });
    }

    if (errors.length > 0) {
      return fail(400, {
        errors,
        values: {
          maxRequestsPerHour: maxRequestsPerHourRaw,
          maxTokensPerPeriod: maxTokensPerPeriodRaw,
          hardSpendLimitUsd: hardSpendLimitUsdRaw,
        },
      });
    }

    try {
      // Upsert user limits
      await sql`
        INSERT INTO user_limits (
          user_id,
          max_requests_per_hour,
          max_tokens_per_period,
          hard_spend_limit_usd,
          period_reset_at
        )
        VALUES (
          ${userId},
          ${maxRequestsPerHour ?? null},
          ${maxTokensPerPeriod ?? null},
          ${hardSpendLimitUsd ?? null},
          now() + interval '1 hour'
        )
        ON CONFLICT (user_id) DO UPDATE SET
          max_requests_per_hour = ${maxRequestsPerHour ?? null},
          max_tokens_per_period = ${maxTokensPerPeriod ?? null},
          hard_spend_limit_usd = ${hardSpendLimitUsd ?? null},
          updated_at = now()
      `;
    } catch (err) {
      console.error("[settings/limits] Failed to update limits:", err);
      return fail(500, {
        errors: [
          {
            field: "general",
            message: "Failed to save limits. Please try again.",
          },
        ],
        values: {
          maxRequestsPerHour: maxRequestsPerHourRaw,
          maxTokensPerPeriod: maxTokensPerPeriodRaw,
          hardSpendLimitUsd: hardSpendLimitUsdRaw,
        },
      });
    }

    return { success: true };
  },
} satisfies Actions;
