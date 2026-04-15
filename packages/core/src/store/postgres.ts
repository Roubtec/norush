/**
 * PostgreSQL Store implementation using postgres.js.
 *
 * All queries use tagged template literals — SQL injection is structurally
 * impossible. Connection via `DATABASE_URL` environment variable.
 */

import { ulid } from 'ulidx';
import type postgres from 'postgres';
import type { JSONValue } from 'postgres';
import type { Store, ResultDeliveryUpdate } from '../interfaces/store.js';
import type {
  Batch,
  CostBreakdownEntry,
  DateRange,
  DetailedUsageStats,
  EventLogEntry,
  NewBatch,
  NewEvent,
  NewRequest,
  NewResult,
  Request,
  Result,
  SlidingWindow,
  UsageStats,
  UserLimits,
  UserLimitsInput,
} from '../types.js';
import { standardCost, batchCost } from '../pricing.js';

// ---------------------------------------------------------------------------
// Row ↔ domain mappers (snake_case → camelCase)
// ---------------------------------------------------------------------------

function toRequest(row: Record<string, unknown>): Request {
  return {
    id: row.id as string,
    externalId: (row.external_id as string) ?? null,
    provider: row.provider as Request['provider'],
    model: row.model as string,
    params: row.params as Record<string, unknown>,
    status: row.status as Request['status'],
    batchId: (row.batch_id as string) ?? null,
    userId: row.user_id as string,
    callbackUrl: (row.callback_url as string) ?? null,
    webhookSecret: (row.webhook_secret as string) ?? null,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    contentScrubbedAt: row.content_scrubbed_at ? new Date(row.content_scrubbed_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function toBatch(row: Record<string, unknown>): Batch {
  return {
    id: row.id as string,
    provider: row.provider as Batch['provider'],
    providerBatchId: (row.provider_batch_id as string) ?? null,
    apiKeyId: row.api_key_id as string,
    apiKeyLabel: (row.api_key_label as string) ?? null,
    status: row.status as Batch['status'],
    requestCount: row.request_count as number,
    succeededCount: row.succeeded_count as number,
    failedCount: row.failed_count as number,
    submissionAttempts: row.submission_attempts as number,
    maxSubmissionAttempts: row.max_submission_attempts as number,
    providerRetries: row.provider_retries as number,
    maxProviderRetries: row.max_provider_retries as number,
    pollingStrategy: (row.polling_strategy as string) ?? null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at as string) : null,
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
    deliveryStatus: row.delivery_status as Result['deliveryStatus'],
    deliveryAttempts: row.delivery_attempts as number,
    maxDeliveryAttempts: row.max_delivery_attempts as number,
    lastDeliveryError: (row.last_delivery_error as string) ?? null,
    nextDeliveryAt: row.next_delivery_at ? new Date(row.next_delivery_at as string) : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at as string) : null,
    contentScrubbedAt: row.content_scrubbed_at ? new Date(row.content_scrubbed_at as string) : null,
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
    return rows.length > 0 ? toRequest(rows[0] as Record<string, unknown>) : null;
  }

  async updateRequest(id: string, updates: Partial<Request>): Promise<void> {
    // Build SET clause from provided updates, mapping camelCase to snake_case.
    const sets: Record<string, unknown> = { updated_at: new Date() };

    if (updates.externalId !== undefined) sets.external_id = updates.externalId;
    if (updates.provider !== undefined) sets.provider = updates.provider;
    if (updates.model !== undefined) sets.model = updates.model;
    if (updates.params !== undefined) sets.params = this.sql.json(updates.params as JSONValue);
    if (updates.status !== undefined) sets.status = updates.status;
    if (updates.batchId !== undefined) sets.batch_id = updates.batchId;
    if (updates.userId !== undefined) sets.user_id = updates.userId;
    if (updates.callbackUrl !== undefined) sets.callback_url = updates.callbackUrl;
    if (updates.webhookSecret !== undefined) sets.webhook_secret = updates.webhookSecret;
    if (updates.retryCount !== undefined) sets.retry_count = updates.retryCount;
    if (updates.maxRetries !== undefined) sets.max_retries = updates.maxRetries;
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

  async assignBatchToRequests(ids: string[], batchId: string, status: 'batched'): Promise<void> {
    if (ids.length === 0) return;
    await this.sql`
      UPDATE requests
      SET batch_id = ${batchId},
          status = ${status},
          updated_at = now()
      WHERE id = ANY(${this.sql.array(ids)})
    `;
  }

  // -- API key lookup -------------------------------------------------------

  async findApiKeyId(userId: string, provider: string): Promise<string | null> {
    const rows = await this.sql`
      SELECT id FROM user_api_keys
      WHERE user_id = ${userId} AND provider = ${provider}
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `;
    return rows.length > 0 ? (rows[0].id as string) : null;
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
    return rows.length > 0 ? toBatch(rows[0] as Record<string, unknown>) : null;
  }

  async updateBatch(id: string, updates: Partial<Batch>): Promise<void> {
    const sets: Record<string, unknown> = { updated_at: new Date() };

    if (updates.provider !== undefined) sets.provider = updates.provider;
    if (updates.providerBatchId !== undefined) sets.provider_batch_id = updates.providerBatchId;
    if (updates.apiKeyId !== undefined) sets.api_key_id = updates.apiKeyId;
    if (updates.apiKeyLabel !== undefined) sets.api_key_label = updates.apiKeyLabel;
    if (updates.status !== undefined) sets.status = updates.status;
    if (updates.requestCount !== undefined) sets.request_count = updates.requestCount;
    if (updates.succeededCount !== undefined) sets.succeeded_count = updates.succeededCount;
    if (updates.failedCount !== undefined) sets.failed_count = updates.failedCount;
    if (updates.submissionAttempts !== undefined)
      sets.submission_attempts = updates.submissionAttempts;
    if (updates.maxSubmissionAttempts !== undefined)
      sets.max_submission_attempts = updates.maxSubmissionAttempts;
    if (updates.providerRetries !== undefined) sets.provider_retries = updates.providerRetries;
    if (updates.maxProviderRetries !== undefined)
      sets.max_provider_retries = updates.maxProviderRetries;
    if (updates.pollingStrategy !== undefined) sets.polling_strategy = updates.pollingStrategy;
    if (updates.submittedAt !== undefined) sets.submitted_at = updates.submittedAt;
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

  async updateResult(id: string, updates: ResultDeliveryUpdate): Promise<void> {
    const sets: Record<string, unknown> = {};

    if (updates.deliveryStatus !== undefined) sets.delivery_status = updates.deliveryStatus;
    if (updates.deliveryAttempts !== undefined) sets.delivery_attempts = updates.deliveryAttempts;
    if (updates.maxDeliveryAttempts !== undefined)
      sets.max_delivery_attempts = updates.maxDeliveryAttempts;
    if (updates.lastDeliveryError !== undefined)
      sets.last_delivery_error = updates.lastDeliveryError;
    if (updates.nextDeliveryAt !== undefined) sets.next_delivery_at = updates.nextDeliveryAt;
    if (updates.deliveredAt !== undefined) sets.delivered_at = updates.deliveredAt;
    if (updates.contentScrubbedAt !== undefined)
      sets.content_scrubbed_at = updates.contentScrubbedAt;

    if (Object.keys(sets).length === 0) return;

    await this.sql`
      UPDATE results SET ${this.sql(sets as Record<string, unknown>, ...Object.keys(sets))}
      WHERE id = ${id}
    `;
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

  // -- Event log ------------------------------------------------------------

  async logEvent(event: NewEvent): Promise<EventLogEntry> {
    const id = ulid();
    const rows = await this.sql`
      INSERT INTO event_log (id, entity_type, entity_id, event, details)
      VALUES (
        ${id},
        ${event.entityType},
        ${event.entityId},
        ${event.event},
        ${event.details ? this.sql.json(event.details as JSONValue) : null}
      )
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      entityType: row.entity_type as EventLogEntry['entityType'],
      entityId: row.entity_id as string,
      event: row.event as string,
      details: (row.details as Record<string, unknown>) ?? null,
      createdAt: new Date(row.created_at as string),
    };
  }

  // -- Retention ------------------------------------------------------------

  async scrubExpiredContent(before: Date): Promise<number> {
    const tombstone = this.sql.json({
      scrubbed: true,
      scrubbed_at: new Date().toISOString(),
    } as JSONValue);

    // Scrub requests: replace params with tombstone for completed requests
    // whose content hasn't been scrubbed yet.
    const scrubbedRequests = await this.sql`
      UPDATE requests
      SET params = ${tombstone},
          content_scrubbed_at = now(),
          updated_at = now()
      WHERE content_scrubbed_at IS NULL
        AND created_at < ${before}
        AND status IN ('succeeded', 'failed', 'failed_final')
    `;

    // Scrub results: replace response with tombstone.
    const scrubbedResults = await this.sql`
      UPDATE results
      SET response = ${tombstone},
          content_scrubbed_at = now()
      WHERE content_scrubbed_at IS NULL
        AND created_at < ${before}
    `;

    return scrubbedRequests.count + scrubbedResults.count;
  }

  async scrubContentForUser(userId: string, before: Date): Promise<number> {
    const tombstone = this.sql.json({
      scrubbed: true,
      scrubbed_at: new Date().toISOString(),
    } as JSONValue);

    // Scrub requests for this user.
    const scrubbedRequests = await this.sql`
      UPDATE requests
      SET params = ${tombstone},
          content_scrubbed_at = now(),
          updated_at = now()
      WHERE user_id = ${userId}
        AND content_scrubbed_at IS NULL
        AND created_at < ${before}
        AND status IN ('succeeded', 'failed', 'failed_final')
    `;

    // Scrub results linked to this user's requests.
    const scrubbedResults = await this.sql`
      UPDATE results
      SET response = ${tombstone},
          content_scrubbed_at = now()
      WHERE content_scrubbed_at IS NULL
        AND created_at < ${before}
        AND request_id IN (
          SELECT id FROM requests WHERE user_id = ${userId}
        )
    `;

    return scrubbedRequests.count + scrubbedResults.count;
  }

  async scrubDeliveredContent(userId: string): Promise<number> {
    const tombstone = this.sql.json({
      scrubbed: true,
      scrubbed_at: new Date().toISOString(),
    } as JSONValue);

    // Scrub results that have been delivered for this user's requests.
    const scrubbedResults = await this.sql`
      UPDATE results
      SET response = ${tombstone},
          content_scrubbed_at = now()
      WHERE content_scrubbed_at IS NULL
        AND delivery_status = 'delivered'
        AND request_id IN (
          SELECT id FROM requests WHERE user_id = ${userId}
        )
    `;

    // Scrub the corresponding requests.
    const scrubbedRequests = await this.sql`
      UPDATE requests
      SET params = ${tombstone},
          content_scrubbed_at = now(),
          updated_at = now()
      WHERE user_id = ${userId}
        AND content_scrubbed_at IS NULL
        AND status IN ('succeeded', 'failed', 'failed_final')
        AND id IN (
          SELECT request_id FROM results
          WHERE delivery_status = 'delivered'
            AND content_scrubbed_at IS NOT NULL
        )
    `;

    return scrubbedResults.count + scrubbedRequests.count;
  }

  async getDistinctUserIdsWithUnscrubbedContent(): Promise<string[]> {
    const rows = await this.sql`
      SELECT DISTINCT user_id FROM requests
      WHERE content_scrubbed_at IS NULL
        AND status IN ('succeeded', 'failed', 'failed_final')
      UNION
      SELECT DISTINCT req.user_id FROM results res
      JOIN requests req ON req.id = res.request_id
      WHERE res.content_scrubbed_at IS NULL
    `;
    return rows.map((row) => row.user_id as string);
  }

  async scrubEventLogForUser(userId: string): Promise<number> {
    const tombstone = this.sql.json({
      scrubbed: true,
      scrubbed_at: new Date().toISOString(),
    } as JSONValue);

    // Scrub event log entries for requests belonging to this user that
    // have been scrubbed.
    const scrubbedRequestEvents = await this.sql`
      UPDATE event_log
      SET details = ${tombstone}
      WHERE details IS NOT NULL
        AND NOT (details ? 'scrubbed')
        AND (
          (entity_type = 'request' AND entity_id IN (
            SELECT id FROM requests
            WHERE user_id = ${userId} AND content_scrubbed_at IS NOT NULL
          ))
          OR
          (entity_type = 'result' AND entity_id IN (
            SELECT res.id FROM results res
            JOIN requests req ON req.id = res.request_id
            WHERE req.user_id = ${userId} AND res.content_scrubbed_at IS NOT NULL
          ))
        )
    `;

    return scrubbedRequestEvents.count;
  }

  async scrubEventLogsForScrubbedContent(): Promise<number> {
    const tombstone = this.sql.json({
      scrubbed: true,
      scrubbed_at: new Date().toISOString(),
    } as JSONValue);

    // Scrub event log entries for any entity (request or result) that has
    // already had its content scrubbed — regardless of which sweep caused it.
    const scrubbed = await this.sql`
      UPDATE event_log
      SET details = ${tombstone}
      WHERE details IS NOT NULL
        AND NOT (details ? 'scrubbed')
        AND (
          (entity_type = 'request' AND entity_id IN (
            SELECT id FROM requests WHERE content_scrubbed_at IS NOT NULL
          ))
          OR
          (entity_type = 'result' AND entity_id IN (
            SELECT id FROM results WHERE content_scrubbed_at IS NOT NULL
          ))
        )
    `;

    return scrubbed.count;
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

  async getDetailedStats(userId: string, period: DateRange): Promise<DetailedUsageStats> {
    // Run the basic stats query and the cost breakdown query in parallel.
    const [basic, breakdownRows, turnaroundRows] = await Promise.all([
      this.getStats(userId, period),

      // Per-provider/model token aggregation.
      this.sql`
        SELECT
          r.provider,
          r.model,
          COUNT(*)::int AS request_count,
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

      // Average batch turnaround time.
      this.sql`
        SELECT AVG(EXTRACT(EPOCH FROM (b.ended_at - b.submitted_at)) * 1000)::double precision AS avg_turnaround_ms
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
    ]);

    const costBreakdown: CostBreakdownEntry[] = breakdownRows.map((row) => {
      const provider = row.provider as string;
      const model = row.model as string;
      const inputTokens = (row.input_tokens as number) ?? 0;
      const outputTokens = (row.output_tokens as number) ?? 0;
      return {
        provider: provider as CostBreakdownEntry['provider'],
        model,
        inputTokens,
        outputTokens,
        batchCostUsd: batchCost(provider, inputTokens, outputTokens),
        standardCostUsd: standardCost(provider, inputTokens, outputTokens),
        requestCount: (row.request_count as number) ?? 0,
      };
    });

    const turnaroundRow = turnaroundRows[0] as Record<string, unknown>;
    const avgTurnaroundMs =
      turnaroundRow.avg_turnaround_ms != null ? Number(turnaroundRow.avg_turnaround_ms) : null;

    const totalStandardCostUsd = costBreakdown.reduce((s, e) => s + e.standardCostUsd, 0);
    const totalBatchCostUsd = costBreakdown.reduce((s, e) => s + e.batchCostUsd, 0);

    return {
      ...basic,
      costBreakdown,
      avgTurnaroundMs,
      totalBatchCostUsd,
      totalStandardCostUsd,
      totalSavingsUsd: totalStandardCostUsd - totalBatchCostUsd,
    };
  }

  // -- User limits (rate limiting / spend controls) --------------------------

  async getUserLimits(userId: string): Promise<UserLimits | null> {
    const rows = await this.sql`
      SELECT * FROM user_limits WHERE user_id = ${userId}
    `;
    if (rows.length === 0) return null;
    return toUserLimits(rows[0] as Record<string, unknown>);
  }

  async upsertUserLimits(userId: string, input: UserLimitsInput): Promise<UserLimits> {
    const rows = await this.sql`
      INSERT INTO user_limits (user_id, max_requests_per_hour, max_tokens_per_period, hard_spend_limit_usd, period_reset_at)
      VALUES (
        ${userId},
        ${input.maxRequestsPerHour ?? null},
        ${input.maxTokensPerPeriod ?? null},
        ${input.hardSpendLimitUsd ?? null},
        now() + interval '1 hour'
      )
      ON CONFLICT (user_id) DO UPDATE SET
        max_requests_per_hour = CASE
          WHEN ${input.maxRequestsPerHour !== undefined} THEN ${input.maxRequestsPerHour ?? null}
          ELSE user_limits.max_requests_per_hour
        END,
        max_tokens_per_period = CASE
          WHEN ${input.maxTokensPerPeriod !== undefined} THEN ${input.maxTokensPerPeriod ?? null}
          ELSE user_limits.max_tokens_per_period
        END,
        hard_spend_limit_usd = CASE
          WHEN ${input.hardSpendLimitUsd !== undefined} THEN ${input.hardSpendLimitUsd ?? null}
          ELSE user_limits.hard_spend_limit_usd
        END,
        updated_at = now()
      RETURNING *
    `;
    return toUserLimits(rows[0] as Record<string, unknown>);
  }

  async incrementPeriodRequests(userId: string, count: number = 1): Promise<void> {
    await this.sql`
      UPDATE user_limits
      SET current_period_requests = current_period_requests + ${count},
          updated_at = now()
      WHERE user_id = ${userId}
    `;
  }

  async consumePeriodRequests(
    userId: string,
    count: number,
    effectiveLimit: number,
  ): Promise<boolean> {
    if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
      throw new Error('count must be a positive integer');
    }
    if (
      !Number.isFinite(effectiveLimit) ||
      effectiveLimit < 0 ||
      !Number.isInteger(effectiveLimit)
    ) {
      throw new Error('effectiveLimit must be a non-negative integer');
    }
    const rows = await this.sql`
      UPDATE user_limits
      SET current_period_requests = current_period_requests + ${count},
          updated_at = now()
      WHERE user_id = ${userId}
        AND current_period_requests + ${count} <= ${effectiveLimit}
      RETURNING current_period_requests
    `;
    return rows.length > 0;
  }

  async incrementPeriodTokens(userId: string, count: number): Promise<void> {
    await this.sql`
      UPDATE user_limits
      SET current_period_tokens = current_period_tokens + ${count},
          updated_at = now()
      WHERE user_id = ${userId}
    `;
  }

  async incrementSpend(userId: string, amountUsd: number): Promise<void> {
    await this.sql`
      UPDATE user_limits
      SET current_spend_usd = current_spend_usd + ${amountUsd},
          updated_at = now()
      WHERE user_id = ${userId}
    `;
  }

  async resetPeriod(userId: string, nextResetAt: Date): Promise<void> {
    // Conditional reset: only execute when the stored period_reset_at is still
    // in the past. This prevents a concurrent request from wiping counters that
    // a sibling request already reset at the same period boundary.
    await this.sql`
      UPDATE user_limits
      SET current_period_requests = 0,
          current_period_tokens = 0,
          period_reset_at = ${nextResetAt},
          updated_at = now()
      WHERE user_id = ${userId}
        AND period_reset_at <= now()
    `;
  }

  async getSlidingWindow(userId: string, windowMs: number): Promise<SlidingWindow> {
    const windowStart = new Date(Date.now() - windowMs);

    const rows = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE b.status = 'ended' AND b.failed_count = 0)::int AS succeeded,
        COUNT(*) FILTER (WHERE b.status IN ('ended', 'failed', 'expired') AND (b.failed_count > 0 OR b.status IN ('failed', 'expired')))::int AS failed
      FROM batches b
      WHERE b.ended_at >= ${windowStart}
        AND EXISTS (
          SELECT 1 FROM requests r
          WHERE r.batch_id = b.id AND r.user_id = ${userId}
        )
    `;

    const row = rows[0] as Record<string, unknown>;
    const succeeded = (row.succeeded as number) ?? 0;
    const failed = (row.failed as number) ?? 0;

    return { total: succeeded + failed, succeeded, failed };
  }
}

// ---------------------------------------------------------------------------
// UserLimits mapper
// ---------------------------------------------------------------------------

function toUserLimits(row: Record<string, unknown>): UserLimits {
  return {
    userId: row.user_id as string,
    maxRequestsPerHour: (row.max_requests_per_hour as number) ?? null,
    maxTokensPerPeriod: (row.max_tokens_per_period as number) ?? null,
    hardSpendLimitUsd: row.hard_spend_limit_usd != null ? Number(row.hard_spend_limit_usd) : null,
    currentPeriodRequests: (row.current_period_requests as number) ?? 0,
    currentPeriodTokens: (row.current_period_tokens as number) ?? 0,
    currentSpendUsd: row.current_spend_usd != null ? Number(row.current_spend_usd) : 0,
    periodResetAt: new Date(row.period_reset_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}
