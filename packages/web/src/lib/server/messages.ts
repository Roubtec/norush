/**
 * Server-side message/result query helpers for the chat UI.
 *
 * Queries the `requests` and `results` tables directly via postgres.js,
 * joining them to build the chat message list. All queries are scoped
 * to the authenticated user.
 */

import type postgres from "postgres";
import type { ProviderName, RequestStatus } from "@norush/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A chat message as displayed in the UI (request + optional result). */
export interface ChatMessage {
  /** The norush request ID. */
  id: string;
  provider: ProviderName;
  model: string;
  /** The user's original prompt/params. */
  params: Record<string, unknown>;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  /** The LLM result, if available. */
  result: ChatResult | null;
}

/** Result data attached to a completed message. */
export interface ChatResult {
  id: string;
  response: Record<string, unknown>;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

/** Input for submitting a new message. */
export interface SubmitMessageInput {
  userId: string;
  provider: ProviderName;
  model: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface MessageValidationError {
  field: string;
  message: string;
}

const VALID_PROVIDERS: ProviderName[] = ["claude", "openai"];

const MAX_CONTENT_LENGTH = 100_000;

/**
 * Validate message submission input.
 * Returns an array of errors (empty if valid).
 */
export function validateMessageInput(input: {
  provider: string;
  model: string;
  content: string;
}): MessageValidationError[] {
  const errors: MessageValidationError[] = [];

  if (!input.provider) {
    errors.push({ field: "provider", message: "Provider is required" });
  } else if (!VALID_PROVIDERS.includes(input.provider as ProviderName)) {
    errors.push({
      field: "provider",
      message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
    });
  }

  if (!input.model || input.model.trim().length === 0) {
    errors.push({ field: "model", message: "Model is required" });
  }

  if (!input.content || input.content.trim().length === 0) {
    errors.push({ field: "content", message: "Message content is required" });
  } else if (input.content.length > MAX_CONTENT_LENGTH) {
    errors.push({
      field: "content",
      message: `Message must be ${MAX_CONTENT_LENGTH.toLocaleString()} characters or fewer`,
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Cost savings calculation
// ---------------------------------------------------------------------------

/**
 * Standard real-time API rates per token (approximate averages).
 * Batch APIs typically offer 50% discount.
 */
const STANDARD_RATES: Record<string, { input: number; output: number }> = {
  claude: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  openai: { input: 2.5 / 1_000_000, output: 10.0 / 1_000_000 },
};

/**
 * Calculate estimated savings from using batch API vs real-time.
 * Batch APIs typically offer 50% discount over standard rates.
 *
 * @returns Estimated savings in USD.
 */
export function calculateSavings(
  provider: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = STANDARD_RATES[provider] ?? STANDARD_RATES.claude;
  const standardCost =
    inputTokens * rates.input + outputTokens * rates.output;
  // Batch discount is 50% off standard rates
  return standardCost * 0.5;
}

// ---------------------------------------------------------------------------
// Query: list messages with results
// ---------------------------------------------------------------------------

/**
 * List a user's messages with their results, ordered by creation time (newest first).
 */
export async function listMessages(
  sql: postgres.Sql,
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ChatMessage[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const rows = await sql`
    SELECT
      r.id,
      r.provider,
      r.model,
      r.params,
      r.status,
      r.created_at AS request_created_at,
      r.updated_at AS request_updated_at,
      res.id AS result_id,
      res.response,
      res.stop_reason,
      res.input_tokens,
      res.output_tokens,
      res.created_at AS result_created_at
    FROM requests r
    LEFT JOIN results res ON res.request_id = r.id
    WHERE r.user_id = ${userId}
    ORDER BY r.created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  return rows.map((row) => ({
    id: row.id as string,
    provider: row.provider as ProviderName,
    model: row.model as string,
    params: row.params as Record<string, unknown>,
    status: row.status as RequestStatus,
    createdAt: (row.request_created_at as Date).toISOString(),
    updatedAt: (row.request_updated_at as Date).toISOString(),
    result: row.result_id
      ? {
          id: row.result_id as string,
          response: row.response as Record<string, unknown>,
          stopReason: (row.stop_reason as string) ?? null,
          inputTokens: (row.input_tokens as number) ?? null,
          outputTokens: (row.output_tokens as number) ?? null,
          createdAt: (row.result_created_at as Date).toISOString(),
        }
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Query: poll results since timestamp
// ---------------------------------------------------------------------------

/** A result with its associated request ID, for polling updates. */
export interface PollResult {
  requestId: string;
  status: RequestStatus;
  result: ChatResult | null;
}

/**
 * Fetch results created after a given timestamp for a user.
 * Used by the client's polling mechanism to pick up new results.
 */
export async function getResultsSince(
  sql: postgres.Sql,
  userId: string,
  since: Date,
): Promise<PollResult[]> {
  const rows = await sql`
    SELECT
      r.id AS request_id,
      r.status,
      res.id AS result_id,
      res.response,
      res.stop_reason,
      res.input_tokens,
      res.output_tokens,
      res.created_at AS result_created_at
    FROM requests r
    LEFT JOIN results res ON res.request_id = r.id
    WHERE r.user_id = ${userId}
      AND (r.updated_at > ${since} OR res.created_at > ${since})
    ORDER BY r.updated_at DESC
  `;

  return rows.map((row) => ({
    requestId: row.request_id as string,
    status: row.status as RequestStatus,
    result: row.result_id
      ? {
          id: row.result_id as string,
          response: row.response as Record<string, unknown>,
          stopReason: (row.stop_reason as string) ?? null,
          inputTokens: (row.input_tokens as number) ?? null,
          outputTokens: (row.output_tokens as number) ?? null,
          createdAt: (row.result_created_at as Date).toISOString(),
        }
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Query: find user's API key for a provider
// ---------------------------------------------------------------------------

/**
 * Find the highest-priority API key ID for a user + provider combination.
 * Returns null if none is configured.
 */
export async function findUserApiKeyId(
  sql: postgres.Sql,
  userId: string,
  provider: string,
): Promise<string | null> {
  const rows = await sql`
    SELECT id FROM user_api_keys
    WHERE user_id = ${userId} AND provider = ${provider}
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `;
  return rows.length > 0 ? (rows[0].id as string) : null;
}
