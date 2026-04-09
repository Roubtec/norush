/**
 * POST /api/v1/requests — Submit one or more requests for batch processing.
 * GET  /api/v1/requests — List the authenticated user's requests (paginated, filterable).
 *
 * Authentication: Bearer token in Authorization header.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getSql, getEngine } from "$lib/server/norush";
import { authenticateApiRequest } from "$lib/server/api-auth";
import type { ProviderName, RequestStatus } from "@norush/core";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function apiError(code: string, message: string, status: number, details?: unknown) {
  return json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: ProviderName[] = ["claude", "openai"];
const VALID_STATUSES: RequestStatus[] = [
  "queued", "batched", "processing", "succeeded", "failed", "expired", "failed_final", "canceled",
];

interface RequestInput {
  provider: string;
  model: string;
  params: Record<string, unknown>;
  callback_url?: string | null;
  webhook_secret?: string | null;
}

interface ValidationError {
  field: string;
  message: string;
}

function validateRequestInput(input: unknown): { data: RequestInput; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const data = input as Record<string, unknown>;

  if (!data || typeof data !== "object") {
    return { data: {} as RequestInput, errors: [{ field: "body", message: "Request body must be a JSON object" }] };
  }

  const provider = String(data.provider ?? "");
  const model = String(data.model ?? "");
  const params = data.params;
  const callbackUrl = data.callback_url;
  const webhookSecret = data.webhook_secret;

  if (!provider) {
    errors.push({ field: "provider", message: "Provider is required" });
  } else if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
    errors.push({ field: "provider", message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}` });
  }

  if (!model || model.trim().length === 0) {
    errors.push({ field: "model", message: "Model is required" });
  }

  if (!params || typeof params !== "object" || Array.isArray(params)) {
    errors.push({ field: "params", message: "Params must be a JSON object" });
  }

  if (callbackUrl !== undefined && callbackUrl !== null && typeof callbackUrl !== "string") {
    errors.push({ field: "callback_url", message: "callback_url must be a string" });
  }

  if (webhookSecret !== undefined && webhookSecret !== null && typeof webhookSecret !== "string") {
    errors.push({ field: "webhook_secret", message: "webhook_secret must be a string" });
  }

  return {
    data: {
      provider,
      model,
      params: (params as Record<string, unknown>) ?? {},
      callback_url: (callbackUrl as string) ?? null,
      webhook_secret: (webhookSecret as string) ?? null,
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// POST — submit one or more requests
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
  const sql = getSql();
  const caller = await authenticateApiRequest(sql, request.headers.get("authorization"));
  if (!caller) {
    return apiError("unauthorized", "Invalid or missing API token", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "Request body must be valid JSON", 400);
  }

  // Support both single object and array of objects
  const isBulk = Array.isArray(body);
  const items: unknown[] = isBulk ? (body as unknown[]) : [body];

  if (items.length === 0) {
    return apiError("empty_request", "At least one request is required", 400);
  }

  if (items.length > 100) {
    return apiError("too_many_requests", "Maximum 100 requests per submission", 400);
  }

  // Validate all items first
  const validatedItems: RequestInput[] = [];
  for (let i = 0; i < items.length; i++) {
    const { data, errors } = validateRequestInput(items[i]);
    if (errors.length > 0) {
      return apiError(
        "validation_error",
        isBulk ? `Validation failed for item ${i}` : "Validation failed",
        400,
        errors,
      );
    }
    validatedItems.push(data);
  }

  // Enqueue all requests
  const engine = await getEngine();
  const created = [];

  for (const item of validatedItems) {
    const req = await engine.enqueue({
      provider: item.provider as ProviderName,
      model: item.model,
      params: item.params,
      userId: caller.userId,
      callbackUrl: item.callback_url,
      webhookSecret: item.webhook_secret,
    });

    created.push({
      id: req.id,
      provider: req.provider,
      model: req.model,
      status: req.status,
      createdAt: req.createdAt.toISOString(),
    });
  }

  const responseBody = isBulk ? { requests: created } : { request: created[0] };
  return json(responseBody, { status: 201 });
};

// ---------------------------------------------------------------------------
// GET — list requests (paginated, filterable)
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
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 100);

  // Parse filters
  const statusFilter = url.searchParams.get("status");
  const providerFilter = url.searchParams.get("provider");

  // Validate status filter
  if (statusFilter && !VALID_STATUSES.includes(statusFilter as RequestStatus)) {
    return apiError(
      "invalid_filter",
      `Invalid status filter. Must be one of: ${VALID_STATUSES.join(", ")}`,
      400,
    );
  }

  // Validate provider filter
  if (providerFilter && !VALID_PROVIDERS.includes(providerFilter as ProviderName)) {
    return apiError(
      "invalid_filter",
      `Invalid provider filter. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
      400,
    );
  }

  // Build query with optional filters and cursor-based pagination.
  // ULIDs are time-sortable so cursor < id gives "older than cursor".
  const rows = await sql`
    SELECT
      r.id, r.provider, r.model, r.status, r.batch_id,
      r.callback_url, r.retry_count, r.max_retries,
      r.created_at, r.updated_at
    FROM requests r
    WHERE r.user_id = ${caller.userId}
      ${cursor ? sql`AND r.id < ${cursor}` : sql``}
      ${statusFilter ? sql`AND r.status = ${statusFilter}` : sql``}
      ${providerFilter ? sql`AND r.provider = ${providerFilter}` : sql``}
    ORDER BY r.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const requests = pageRows.map((row) => ({
    id: row.id as string,
    provider: row.provider as string,
    model: row.model as string,
    status: row.status as string,
    batchId: (row.batch_id as string) ?? null,
    callbackUrl: (row.callback_url as string) ?? null,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }));

  const nextCursor = hasMore && pageRows.length > 0
    ? (pageRows[pageRows.length - 1].id as string)
    : null;

  return json({
    requests,
    pagination: {
      cursor: nextCursor,
      hasMore,
      limit,
    },
  });
};
