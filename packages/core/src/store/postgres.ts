/**
 * PostgreSQL Store implementation using postgres.js.
 *
 * All queries use tagged template literals — SQL injection is structurally
 * impossible. Connection via `DATABASE_URL` environment variable.
 */

import { ulid } from "ulidx";
import type postgres from "postgres";
import type { JSONValue } from "postgres";
import type { Store } from "../interfaces/store.js";
import type {
  Batch,
  DateRange,
  NewBatch,
  NewRequest,
  NewResult,
  Request,
  Result,
  UsageStats,
} from "../types.js";

// ---------------------------------------------------------------------------
// Row ↔ domain mappers (snake_case → camelCase)
// ---------------------------------------------------------------------------

function toRequest(row: Record<string, unknown>): Request {
  return {
    id: row.id as string,
    externalId: (row.external_id as string) ?? null,
    provider: row.provider as Request["provider"],
    model: row.model as string,
    params: row.params as Record<string, unknown>,
    status: row.status as Request["status"],
    batchId: (row.batch_id as string) ?? null,
    userId: row.user_id as string,
    callbackUrl: (row.callback_url as string) ?? null,
    webhookSecret: (row.webhook_secret as string) ?? null,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    contentScrubbedAt: row.content_scrubbed_at
      ? new Date(row.content_scrubbed_at as string)
      : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function toBatch(row: Record<string, unknown>): Batch {
  return {
    id: row.id as string,
    provider: row.provider as Batch["provider"],
    providerBatchId: (row.provider_batch_id as string) ?? null,
    apiKeyId: row.api_key_id as string,
    apiKeyLabel: (row.api_key_label as string) ?? null,
    status: row.status as Batch["status"],
    requestCount: row.request_count as number,
    succeededCount: row.succeeded_count as number,
    failedCount: row.failed_count as number,
    submissionAttempts: row.submission_attempts as number,
    maxSubmissionAttempts: row.max_submission_attempts as number,
    providerRetries: row.provider_retries as number,
    maxProviderRetries: row.max_provider_retries as number,
    pollingStrategy: (row.polling_strategy as string) ?? null,
    submittedAt: row.submitted_at
      ? new Date(row.submitted_at as string)
      : null,
    endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function toResult(row: Record<string, unknown>): Result {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    batchId: row.batch_id as string,
    response: row.response as Record<string, unknown>,
    stopReason: (row.stop_reason as string) ?? null,
    inputTokens: (row.input_tokens as number) ?? null,
    outputTokens: (row.output_tokens as number) ?? null,
    deliveryStatus: row.delivery_status as Result["deliveryStatus"],
    deliveryAttempts: row.delivery_attempts as number,
    maxDeliveryAttempts: row.max_delivery_attempts as number,
    lastDeliveryError: (row.last_delivery_error as string) ?? null,
    nextDeliveryAt: row.next_delivery_at
      ? new Date(row.next_delivery_at as string)
      : null,
    deliveredAt: row.delivered_at
      ? new Date(row.delivered_at as string)
      : null,
    contentScrubbedAt: row.content_scrubbed_at
      ? new Date(row.content_scrubbed_at as string)
      : null,
    createdAt: new Date(row.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

export class PostgresStore implements Store {
  constructor(private readonly sql: postgres.Sql) {}

  // -- Request lifecycle ----------------------------------------------------

  async createRequest(req: NewRequest): Promise<Request> {
    const id = ulid();
    const rows = await this.sql`
      INSERT INTO requests (id, provider, model, params, user_id, callback_url, webhook_secret, max_retries)
      VALUES (
        ${id},
        ${req.provider},
        ${req.model},
        ${this.sql.json(req.params as JSONValue)},
        ${req.userId},
        ${req.callbackUrl ?? null},
        ${req.webhookSecret ?? null},
        ${req.maxRetries ?? 5}
      )
      RETURNING *
    `;
    return toRequest(rows[0] as Record<string, unknown>);
  }

  async getRequest(id: string): Promise<Request | null> {
    const rows = await this.sql`
      SELECT * FROM requests WHERE id = ${id}
    `;
    return rows.length > 0
      ? toRequest(rows[0] as Record<string, unknown>)
      : null;
  }

  async updateRequest(id: string, updates: Partial<Request>): Promise<void> {
    // Build SET clause from provided updates, mapping camelCase to snake_case.
    const sets: Record<string, unknown> = { updated_at: new Date() };

    if (updates.externalId !== undefined)
      sets.external_id = updates.externalId;
    if (updates.provider !== undefined) sets.provider = updates.provider;
    if (updates.model !== undefined) sets.model = updates.model;
    if (updates.params !== undefined)
      sets.params = this.sql.json(updates.params as JSONValue);
    if (updates.status !== undefined) sets.status = updates.status;
    if (updates.batchId !== undefined) sets.batch_id = updates.batchId;
    if (updates.userId !== undefined) sets.user_id = updates.userId;
    if (updates.callbackUrl !== undefined)
      sets.callback_url = updates.callbackUrl;
    if (updates.webhookSecret !== undefined)
      sets.webhook_secret = updates.webhookSecret;
    if (updates.retryCount !== undefined)
      sets.retry_count = updates.retryCount;
    if (updates.maxRetries !== undefined)
      sets.max_retries = updates.maxRetries;
    if (updates.contentScrubbedAt !== undefined)
      sets.content_scrubbed_at = updates.contentScrubbedAt;

    await this.sql`
      UPDATE requests SET ${this.sql(sets as Record<string, unknown>, ...Object.keys(sets))}
      WHERE id = ${id}
    `;
  }

  async getQueuedRequests(limit: number): Promise<Request[]> {
    const rows = await this.sql`
      SELECT * FROM requests
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => toRequest(r as Record<string, unknown>));
  }

  async assignBatchToRequests(
    ids: string[],
    batchId: string,
    status: "batched",
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.sql`
      UPDATE requests
      SET batch_id = ${batchId},
          status = ${status},
          updated_at = now()
      WHERE id = ANY(${this.sql.array(ids)})
    `;
  }

  // -- Batch lifecycle ------------------------------------------------------

  async createBatch(batch: NewBatch): Promise<Batch> {
    const id = ulid();
    const rows = await this.sql`
      INSERT INTO batches (
        id, provider, api_key_id, api_key_label, request_count,
        max_submission_attempts, max_provider_retries, polling_strategy
      )
      VALUES (
        ${id},
        ${batch.provider},
        ${batch.apiKeyId},
        ${batch.apiKeyLabel ?? null},
        ${batch.requestCount},
        ${batch.maxSubmissionAttempts ?? 3},
        ${batch.maxProviderRetries ?? 5},
        ${batch.pollingStrategy ?? null}
      )
      RETURNING *
    `;
    return toBatch(rows[0] as Record<string, unknown>);
  }

  async getBatch(id: string): Promise<Batch | null> {
    const rows = await this.sql`
      SELECT * FROM batches WHERE id = ${id}
    `;
    return rows.length > 0
      ? toBatch(rows[0] as Record<string, unknown>)
      : null;
  }

  async updateBatch(id: string, updates: Partial<Batch>): Promise<void> {
    const sets: Record<string, unknown> = { updated_at: new Date() };

    if (updates.provider !== undefined) sets.provider = updates.provider;
    if (updates.providerBatchId !== undefined)
      sets.provider_batch_id = updates.providerBatchId;
    if (updates.apiKeyId !== undefined) sets.api_key_id = updates.apiKeyId;
    if (updates.apiKeyLabel !== undefined)
      sets.api_key_label = updates.apiKeyLabel;
    if (updates.status !== undefined) sets.status = updates.status;
    if (updates.requestCount !== undefined)
      sets.request_count = updates.requestCount;
    if (updates.succeededCount !== undefined)
      sets.succeeded_count = updates.succeededCount;
    if (updates.failedCount !== undefined)
      sets.failed_count = updates.failedCount;
    if (updates.submissionAttempts !== undefined)
      sets.submission_attempts = updates.submissionAttempts;
    if (updates.maxSubmissionAttempts !== undefined)
      sets.max_submission_attempts = updates.maxSubmissionAttempts;
    if (updates.providerRetries !== undefined)
      sets.provider_retries = updates.providerRetries;
    if (updates.maxProviderRetries !== undefined)
      sets.max_provider_retries = updates.maxProviderRetries;
    if (updates.pollingStrategy !== undefined)
      sets.polling_strategy = updates.pollingStrategy;
    if (updates.submittedAt !== undefined)
      sets.submitted_at = updates.submittedAt;
    if (updates.endedAt !== undefined) sets.ended_at = updates.endedAt;

    await this.sql`
      UPDATE batches SET ${this.sql(sets as Record<string, unknown>, ...Object.keys(sets))}
      WHERE id = ${id}
    `;
  }

  async getPendingBatches(): Promise<Batch[]> {
    const rows = await this.sql`
      SELECT * FROM batches
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `;
    return rows.map((r) => toBatch(r as Record<string, unknown>));
  }

  async getInFlightBatches(): Promise<Batch[]> {
    const rows = await this.sql`
      SELECT * FROM batches
      WHERE status IN ('submitted', 'processing')
      ORDER BY created_at ASC
    `;
    return rows.map((r) => toBatch(r as Record<string, unknown>));
  }

  async getRequestsByBatchId(batchId: string): Promise<Request[]> {
    const rows = await this.sql`
      SELECT * FROM requests
      WHERE batch_id = ${batchId}
      ORDER BY created_at ASC
    `;
    return rows.map((r) => toRequest(r as Record<string, unknown>));
  }

  // -- Result lifecycle -----------------------------------------------------

  async createResult(result: NewResult): Promise<Result> {
    const id = ulid();
    const rows = await this.sql`
      INSERT INTO results (
        id, request_id, batch_id, response, stop_reason,
        input_tokens, output_tokens
      )
      VALUES (
        ${id},
        ${result.requestId},
        ${result.batchId},
        ${this.sql.json(result.response as JSONValue)},
        ${result.stopReason ?? null},
        ${result.inputTokens ?? null},
        ${result.outputTokens ?? null}
      )
      RETURNING *
    `;
    return toResult(rows[0] as Record<string, unknown>);
  }

  async getUndeliveredResults(limit: number): Promise<Result[]> {
    const rows = await this.sql`
      SELECT * FROM results
      WHERE delivery_status IN ('pending', 'failed')
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => toResult(r as Record<string, unknown>));
  }

  async markDelivered(id: string): Promise<void> {
    await this.sql`
      UPDATE results
      SET delivery_status = 'delivered', delivered_at = now()
      WHERE id = ${id}
    `;
  }

  // -- Retention ------------------------------------------------------------

  async scrubExpiredContent(before: Date): Promise<number> {
    // Scrub requests: replace params with tombstone for completed requests
    // whose content hasn't been scrubbed yet.
    const scrubbedRequests = await this.sql`
      UPDATE requests
      SET params = '{"scrubbed": true}'::jsonb,
          content_scrubbed_at = now(),
          updated_at = now()
      WHERE content_scrubbed_at IS NULL
        AND created_at < ${before}
        AND status IN ('succeeded', 'failed', 'failed_final')
    `;

    // Scrub results: replace response with tombstone.
    const scrubbedResults = await this.sql`
      UPDATE results
      SET response = '{"scrubbed": true}'::jsonb,
          content_scrubbed_at = now()
      WHERE content_scrubbed_at IS NULL
        AND created_at < ${before}
    `;

    return scrubbedRequests.count + scrubbedResults.count;
  }

  // -- Telemetry / analytics ------------------------------------------------

  async getStats(userId: string, period: DateRange): Promise<UsageStats> {
    const rows = await this.sql`
      SELECT
        COUNT(*)::int AS total_requests,
        COUNT(*) FILTER (WHERE r.status = 'succeeded')::int AS succeeded_requests,
        COUNT(*) FILTER (WHERE r.status IN ('failed', 'failed_final'))::int AS failed_requests,
        COALESCE(SUM(res.input_tokens), 0)::int AS total_input_tokens,
        COALESCE(SUM(res.output_tokens), 0)::int AS total_output_tokens,
        COUNT(DISTINCT r.batch_id)::int AS total_batches
      FROM requests r
      LEFT JOIN results res ON res.request_id = r.id
      WHERE r.user_id = ${userId}
        AND r.created_at >= ${period.from}
        AND r.created_at <= ${period.to}
    `;

    const row = rows[0] as Record<string, unknown>;
    return {
      totalRequests: (row.total_requests as number) ?? 0,
      succeededRequests: (row.succeeded_requests as number) ?? 0,
      failedRequests: (row.failed_requests as number) ?? 0,
      totalInputTokens: (row.total_input_tokens as number) ?? 0,
      totalOutputTokens: (row.total_output_tokens as number) ?? 0,
      totalBatches: (row.total_batches as number) ?? 0,
    };
  }
}
