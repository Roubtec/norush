/**
 * Shared Store contract test suite.
 *
 * Exercises every Store interface method. Called by both memory.test.ts and
 * postgres.test.ts with their respective Store factories.
 */

import { describe, expect, it } from "vitest";
import type { Store } from "../../interfaces/store.js";
import type { NewRequest, NewBatch, NewResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function newRequest(overrides?: Partial<NewRequest>): NewRequest {
  return {
    provider: "claude",
    model: "claude-sonnet-4-6",
    params: { messages: [{ role: "user", content: "Hello" }] },
    userId: "test-user",
    ...overrides,
  };
}

function newBatch(overrides?: Partial<NewBatch>): NewBatch {
  return {
    provider: "claude",
    apiKeyId: "test-key",
    requestCount: 1,
    ...overrides,
  };
}

function newResult(
  requestId: string,
  batchId: string,
  overrides?: Partial<NewResult>,
): NewResult {
  return {
    requestId,
    batchId,
    response: { content: "Hello back" },
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

/**
 * Run the full Store contract test suite.
 *
 * @param factory Creates a fresh Store instance. Called at the start of each test.
 * @param shouldSkip Optional function that returns true if the suite should be
 *   skipped (e.g., database not available). Evaluated at test execution time
 *   (inside beforeAll), not at registration time.
 */
export function runStoreContractTests(
  factory: () => Store | Promise<Store>,
  shouldSkip?: () => boolean,
): void {
  // Wrapper that skips individual tests when shouldSkip returns true.
  function test(
    name: string,
    fn: () => Promise<void>,
  ): void {
    it(name, async (ctx) => {
      if (shouldSkip?.()) {
        ctx.skip();
        return;
      }
      await fn();
    });
  }

  let store: Store;

  describe("Store contract", () => {
    describe("Request lifecycle", () => {
      test("createRequest returns a record with generated ID and defaults", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest());

        expect(req.id).toBeTruthy();
        expect(req.provider).toBe("claude");
        expect(req.model).toBe("claude-sonnet-4-6");
        expect(req.status).toBe("queued");
        expect(req.batchId).toBeNull();
        expect(req.retryCount).toBe(0);
        expect(req.maxRetries).toBe(5);
        expect(req.contentScrubbedAt).toBeNull();
        expect(req.createdAt).toBeInstanceOf(Date);
        expect(req.updatedAt).toBeInstanceOf(Date);
      });

      test("createRequest respects optional fields", async () => {
        store = await factory();
        const req = await store.createRequest(
          newRequest({
            callbackUrl: "https://example.com/hook",
            webhookSecret: "secret123",
            maxRetries: 3,
          }),
        );

        expect(req.callbackUrl).toBe("https://example.com/hook");
        expect(req.webhookSecret).toBe("secret123");
        expect(req.maxRetries).toBe(3);
      });

      test("getRequest returns the request by ID", async () => {
        store = await factory();
        const created = await store.createRequest(newRequest());
        const fetched = await store.getRequest(created.id);

        expect(fetched).not.toBeNull();
        expect(fetched?.id).toBe(created.id);
        expect(fetched?.provider).toBe("claude");
      });

      test("getRequest returns null for unknown ID", async () => {
        store = await factory();
        const result = await store.getRequest("nonexistent");
        expect(result).toBeNull();
      });

      test("updateRequest modifies fields", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());
        await store.updateRequest(req.id, {
          status: "batched",
          batchId: batch.id,
        });

        const updated = await store.getRequest(req.id);
        expect(updated).not.toBeNull();
        expect(updated?.status).toBe("batched");
        expect(updated?.batchId).toBe(batch.id);
        expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
          req.updatedAt.getTime(),
        );
      });

      test("getQueuedRequests returns only queued requests in order", async () => {
        store = await factory();
        const r1 = await store.createRequest(newRequest());
        const r2 = await store.createRequest(newRequest());
        await store.updateRequest(r1.id, { status: "batched" });
        const r3 = await store.createRequest(newRequest());

        const queued = await store.getQueuedRequests(10);
        expect(queued.length).toBe(2);
        expect(queued[0].id).toBe(r2.id);
        expect(queued[1].id).toBe(r3.id);
      });

      test("getQueuedRequests respects limit", async () => {
        store = await factory();
        await store.createRequest(newRequest());
        await store.createRequest(newRequest());
        await store.createRequest(newRequest());

        const queued = await store.getQueuedRequests(2);
        expect(queued.length).toBe(2);
      });
    });

    describe("Batch lifecycle", () => {
      test("createBatch returns a record with generated ID and defaults", async () => {
        store = await factory();
        const batch = await store.createBatch(newBatch());

        expect(batch.id).toBeTruthy();
        expect(batch.provider).toBe("claude");
        expect(batch.status).toBe("pending");
        expect(batch.providerBatchId).toBeNull();
        expect(batch.requestCount).toBe(1);
        expect(batch.succeededCount).toBe(0);
        expect(batch.failedCount).toBe(0);
        expect(batch.submissionAttempts).toBe(0);
        expect(batch.maxSubmissionAttempts).toBe(3);
        expect(batch.providerRetries).toBe(0);
        expect(batch.maxProviderRetries).toBe(5);
        expect(batch.submittedAt).toBeNull();
        expect(batch.endedAt).toBeNull();
        expect(batch.createdAt).toBeInstanceOf(Date);
      });

      test("getBatch returns the batch by ID", async () => {
        store = await factory();
        const created = await store.createBatch(newBatch());
        const fetched = await store.getBatch(created.id);

        expect(fetched).not.toBeNull();
        expect(fetched?.id).toBe(created.id);
      });

      test("getBatch returns null for unknown ID", async () => {
        store = await factory();
        const result = await store.getBatch("nonexistent");
        expect(result).toBeNull();
      });

      test("updateBatch modifies fields", async () => {
        store = await factory();
        const batch = await store.createBatch(newBatch());
        const submittedAt = new Date();
        await store.updateBatch(batch.id, {
          status: "submitted",
          providerBatchId: "provider-123",
          submittedAt,
        });

        const updated = await store.getBatch(batch.id);
        expect(updated).not.toBeNull();
        expect(updated?.status).toBe("submitted");
        expect(updated?.providerBatchId).toBe("provider-123");
        expect(updated?.submittedAt).toBeInstanceOf(Date);
      });

      test("getPendingBatches returns only pending batches", async () => {
        store = await factory();
        const b1 = await store.createBatch(newBatch());
        const b2 = await store.createBatch(newBatch());
        await store.updateBatch(b1.id, { status: "submitted" });

        const pending = await store.getPendingBatches();
        expect(pending.length).toBe(1);
        expect(pending[0].id).toBe(b2.id);
      });

      test("getInFlightBatches returns submitted and processing batches", async () => {
        store = await factory();
        const b1 = await store.createBatch(newBatch());
        const b2 = await store.createBatch(newBatch());
        const b3 = await store.createBatch(newBatch());
        // b4 stays "pending" — created but not updated
        await store.createBatch(newBatch());

        await store.updateBatch(b1.id, { status: "submitted" });
        await store.updateBatch(b2.id, { status: "processing" });
        await store.updateBatch(b3.id, { status: "ended" });

        const inFlight = await store.getInFlightBatches();
        expect(inFlight.length).toBe(2);
        const ids = inFlight.map((b) => b.id);
        expect(ids).toContain(b1.id);
        expect(ids).toContain(b2.id);
      });
    });

    describe("Result lifecycle", () => {
      test("createResult returns a record with generated ID and defaults", async () => {
        store = await factory();
        // Create prerequisite request and batch.
        const req = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());

        const result = await store.createResult(
          newResult(req.id, batch.id),
        );

        expect(result.id).toBeTruthy();
        expect(result.requestId).toBe(req.id);
        expect(result.batchId).toBe(batch.id);
        expect(result.deliveryStatus).toBe("pending");
        expect(result.deliveryAttempts).toBe(0);
        expect(result.maxDeliveryAttempts).toBe(5);
        expect(result.deliveredAt).toBeNull();
        expect(result.contentScrubbedAt).toBeNull();
        expect(result.stopReason).toBe("end_turn");
        expect(result.inputTokens).toBe(10);
        expect(result.outputTokens).toBe(20);
        expect(result.createdAt).toBeInstanceOf(Date);
      });

      test("getUndeliveredResults returns pending and failed results", async () => {
        store = await factory();
        const req1 = await store.createRequest(newRequest());
        const req2 = await store.createRequest(newRequest());
        const req3 = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());

        const res1 = await store.createResult(
          newResult(req1.id, batch.id),
        );
        const res2 = await store.createResult(
          newResult(req2.id, batch.id),
        );
        const res3 = await store.createResult(
          newResult(req3.id, batch.id),
        );

        await store.markDelivered(res1.id);

        const undelivered = await store.getUndeliveredResults(10);
        expect(undelivered.length).toBe(2);
        const ids = undelivered.map((r) => r.id);
        expect(ids).toContain(res2.id);
        expect(ids).toContain(res3.id);
      });

      test("getUndeliveredResults respects limit", async () => {
        store = await factory();
        const batch = await store.createBatch(newBatch());

        for (let i = 0; i < 5; i++) {
          const req = await store.createRequest(newRequest());
          await store.createResult(newResult(req.id, batch.id));
        }

        const undelivered = await store.getUndeliveredResults(3);
        expect(undelivered.length).toBe(3);
      });

      test("markDelivered updates delivery status and timestamp", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());
        const result = await store.createResult(
          newResult(req.id, batch.id),
        );

        await store.markDelivered(result.id);

        const undelivered = await store.getUndeliveredResults(10);
        const found = undelivered.find((r) => r.id === result.id);
        expect(found).toBeUndefined();
      });
    });

    describe("Retention", () => {
      test("scrubExpiredContent replaces content with tombstones", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());
        await store.updateRequest(req.id, { status: "succeeded" });
        await store.createResult(newResult(req.id, batch.id));

        // Scrub everything created before "now + 1 hour" (i.e., everything).
        const future = new Date(Date.now() + 3600_000);
        const count = await store.scrubExpiredContent(future);

        expect(count).toBeGreaterThanOrEqual(2); // at least 1 request + 1 result

        const scrubbedReq = await store.getRequest(req.id);
        expect(scrubbedReq).not.toBeNull();
        expect(scrubbedReq?.params).toMatchObject({ scrubbed: true });
        expect(scrubbedReq?.params).toHaveProperty("scrubbed_at");
        expect(scrubbedReq?.contentScrubbedAt).toBeInstanceOf(Date);
      });

      test("scrubExpiredContent skips already-scrubbed records", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());
        await store.updateRequest(req.id, { status: "succeeded" });
        await store.createResult(newResult(req.id, batch.id));

        const future = new Date(Date.now() + 3600_000);
        const count1 = await store.scrubExpiredContent(future);
        expect(count1).toBeGreaterThanOrEqual(2);

        const count2 = await store.scrubExpiredContent(future);
        expect(count2).toBe(0);
      });

      test("scrubExpiredContent does not scrub non-terminal requests", async () => {
        store = await factory();
        // Create a queued request (not succeeded/failed/failed_final).
        const req = await store.createRequest(newRequest());

        const future = new Date(Date.now() + 3600_000);
        const count = await store.scrubExpiredContent(future);

        // The request should not be scrubbed (still queued).
        const fetched = await store.getRequest(req.id);
        expect(fetched).not.toBeNull();
        expect(fetched?.contentScrubbedAt).toBeNull();
        expect(fetched?.params).not.toMatchObject({ scrubbed: true });

        // count may be 0 (no results either).
        expect(count).toBe(0);
      });

      test("scrubContentForUser scrubs only that user's content", async () => {
        store = await factory();
        const req1 = await store.createRequest(newRequest({ userId: "alice" }));
        const req2 = await store.createRequest(newRequest({ userId: "bob" }));
        const batch = await store.createBatch(newBatch());
        await store.updateRequest(req1.id, { status: "succeeded" });
        await store.updateRequest(req2.id, { status: "succeeded" });
        await store.createResult(newResult(req1.id, batch.id));
        await store.createResult(newResult(req2.id, batch.id));

        const future = new Date(Date.now() + 3600_000);
        const count = await store.scrubContentForUser("alice", future);

        expect(count).toBeGreaterThanOrEqual(1);

        const aliceReq = await store.getRequest(req1.id);
        expect(aliceReq?.params).toMatchObject({ scrubbed: true });

        const bobReq = await store.getRequest(req2.id);
        expect(bobReq?.contentScrubbedAt).toBeNull();
        expect(bobReq?.params).not.toMatchObject({ scrubbed: true });
      });

      test("scrubContentForUser is idempotent", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest({ userId: "alice" }));
        const batch = await store.createBatch(newBatch());
        await store.updateRequest(req.id, { status: "succeeded" });
        await store.createResult(newResult(req.id, batch.id));

        const future = new Date(Date.now() + 3600_000);
        const count1 = await store.scrubContentForUser("alice", future);
        expect(count1).toBeGreaterThanOrEqual(1);

        const count2 = await store.scrubContentForUser("alice", future);
        expect(count2).toBe(0);
      });

      test("scrubDeliveredContent scrubs only delivered results", async () => {
        store = await factory();
        const req1 = await store.createRequest(newRequest({ userId: "alice" }));
        const req2 = await store.createRequest(newRequest({ userId: "alice" }));
        const batch = await store.createBatch(newBatch());
        await store.updateRequest(req1.id, { status: "succeeded" });
        await store.updateRequest(req2.id, { status: "succeeded" });

        const res1 = await store.createResult(newResult(req1.id, batch.id));
        await store.createResult(newResult(req2.id, batch.id));

        // Only deliver the first result.
        await store.markDelivered(res1.id);

        const count = await store.scrubDeliveredContent("alice");

        // At least the delivered result should be scrubbed.
        expect(count).toBeGreaterThanOrEqual(1);
      });

      test("getDistinctUserIdsWithUnscrubbedContent returns only users with unscrubbed content", async () => {
        store = await factory();
        const req1 = await store.createRequest(newRequest({ userId: "alice" }));
        const req2 = await store.createRequest(newRequest({ userId: "bob" }));
        const batch = await store.createBatch(newBatch());
        await store.updateRequest(req1.id, { status: "succeeded" });
        await store.updateRequest(req2.id, { status: "succeeded" });
        await store.createResult(newResult(req1.id, batch.id));
        await store.createResult(newResult(req2.id, batch.id));

        let userIds = await store.getDistinctUserIdsWithUnscrubbedContent();
        expect(userIds).toContain("alice");
        expect(userIds).toContain("bob");

        // Scrub alice's content.
        const future = new Date(Date.now() + 3600_000);
        await store.scrubContentForUser("alice", future);

        userIds = await store.getDistinctUserIdsWithUnscrubbedContent();
        expect(userIds).not.toContain("alice");
        expect(userIds).toContain("bob");
      });

      test("scrubEventLogForUser scrubs event details for scrubbed entities", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest({ userId: "alice" }));
        await store.updateRequest(req.id, { status: "succeeded" });

        await store.logEvent({
          entityType: "request",
          entityId: req.id,
          event: "submitted",
          details: { sensitive: "data" },
        });

        // Scrub alice's content first.
        const future = new Date(Date.now() + 3600_000);
        await store.scrubContentForUser("alice", future);

        // Then scrub the event log.
        const count = await store.scrubEventLogForUser("alice");
        expect(count).toBeGreaterThanOrEqual(1);
      });

      test("scrubEventLogsForScrubbedContent scrubs event details for all scrubbed entities", async () => {
        store = await factory();

        // Create two users each with a scrubbed request.
        const reqAlice = await store.createRequest(newRequest({ userId: "alice" }));
        await store.updateRequest(reqAlice.id, { status: "succeeded" });
        await store.logEvent({
          entityType: "request",
          entityId: reqAlice.id,
          event: "submitted",
          details: { sensitive: "alice-data" },
        });

        const reqBob = await store.createRequest(newRequest({ userId: "bob" }));
        await store.updateRequest(reqBob.id, { status: "succeeded" });
        await store.logEvent({
          entityType: "request",
          entityId: reqBob.id,
          event: "submitted",
          details: { sensitive: "bob-data" },
        });

        // Scrub content for both users.
        const future = new Date(Date.now() + 3600_000);
        await store.scrubContentForUser("alice", future);
        await store.scrubContentForUser("bob", future);

        // scrubEventLogsForScrubbedContent should scrub both.
        const count = await store.scrubEventLogsForScrubbedContent();
        expect(count).toBeGreaterThanOrEqual(2);
      });

      test("scrubEventLogsForScrubbedContent is idempotent", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest({ userId: "alice" }));
        await store.updateRequest(req.id, { status: "succeeded" });
        await store.logEvent({
          entityType: "request",
          entityId: req.id,
          event: "submitted",
          details: { sensitive: "data" },
        });

        const future = new Date(Date.now() + 3600_000);
        await store.scrubContentForUser("alice", future);

        const count1 = await store.scrubEventLogsForScrubbedContent();
        expect(count1).toBeGreaterThanOrEqual(1);

        // Second call should return 0 (already scrubbed).
        const count2 = await store.scrubEventLogsForScrubbedContent();
        expect(count2).toBe(0);
      });
    });

    describe("Event log", () => {
      test("logEvent creates an event log entry with generated ID", async () => {
        store = await factory();
        const entry = await store.logEvent({
          entityType: "result",
          entityId: "res_001",
          event: "webhook_delivered",
          details: { attempt: 1, statusCode: 200 },
        });

        expect(entry.id).toBeTruthy();
        expect(entry.entityType).toBe("result");
        expect(entry.entityId).toBe("res_001");
        expect(entry.event).toBe("webhook_delivered");
        expect(entry.details).toEqual({ attempt: 1, statusCode: 200 });
        expect(entry.createdAt).toBeInstanceOf(Date);
      });

      test("logEvent handles null details", async () => {
        store = await factory();
        const entry = await store.logEvent({
          entityType: "batch",
          entityId: "batch_001",
          event: "submitted",
        });

        expect(entry.details).toBeNull();
      });
    });

    describe("consumePeriodRequests (atomic rate limit)", () => {
      test("returns true and increments counter when under limit", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { maxRequestsPerHour: 100 });

        const consumed = await store.consumePeriodRequests("test-user", 5, 100);
        expect(consumed).toBe(true);

        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentPeriodRequests).toBe(5);
      });

      test("returns true when exactly at limit boundary", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { maxRequestsPerHour: 10 });

        // Consume 7 first
        await store.consumePeriodRequests("test-user", 7, 10);

        // Consume remaining 3 (7 + 3 = 10, exactly at limit)
        const consumed = await store.consumePeriodRequests("test-user", 3, 10);
        expect(consumed).toBe(true);

        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentPeriodRequests).toBe(10);
      });

      test("returns false and does not increment when over limit", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { maxRequestsPerHour: 10 });

        // Consume 8
        await store.consumePeriodRequests("test-user", 8, 10);

        // Try to consume 5 more (8 + 5 = 13 > 10)
        const consumed = await store.consumePeriodRequests("test-user", 5, 10);
        expect(consumed).toBe(false);

        // Counter should remain at 8
        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentPeriodRequests).toBe(8);
      });

      test("returns false for non-existent user", async () => {
        store = await factory();
        const consumed = await store.consumePeriodRequests("nonexistent", 1, 100);
        expect(consumed).toBe(false);
      });

      test("returns false when single request would exceed limit of 0", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { maxRequestsPerHour: 10 });

        // effective limit of 0 means nothing is allowed
        const consumed = await store.consumePeriodRequests("test-user", 1, 0);
        expect(consumed).toBe(false);
      });

      test("concurrent consume calls never exceed the limit", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { maxRequestsPerHour: 5 });

        // Fire 10 concurrent consume(1) calls against a limit of 5.
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            store.consumePeriodRequests("test-user", 1, 5),
          ),
        );

        const successes = results.filter((r) => r === true).length;
        const failures = results.filter((r) => r === false).length;

        // Exactly 5 should succeed and 5 should fail.
        expect(successes).toBe(5);
        expect(failures).toBe(5);

        // Counter must be exactly at the limit, never above.
        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentPeriodRequests).toBe(5);
      });
    });

    describe("incrementPeriodTokens", () => {
      test("increments currentPeriodTokens on the user limits row", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { maxTokensPerPeriod: 10000 });

        await store.incrementPeriodTokens("test-user", 150);

        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentPeriodTokens).toBe(150);
      });

      test("accumulates across multiple calls", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { maxTokensPerPeriod: 10000 });

        await store.incrementPeriodTokens("test-user", 100);
        await store.incrementPeriodTokens("test-user", 250);
        await store.incrementPeriodTokens("test-user", 50);

        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentPeriodTokens).toBe(400);
      });

      test("does not throw for non-existent user", async () => {
        store = await factory();
        await expect(
          store.incrementPeriodTokens("nonexistent", 100),
        ).resolves.toBeUndefined();
      });
    });

    describe("incrementSpend", () => {
      test("increments currentSpendUsd on the user limits row", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { hardSpendLimitUsd: 100 });

        await store.incrementSpend("test-user", 1.5);

        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentSpendUsd).toBeCloseTo(1.5);
      });

      test("accumulates across multiple calls", async () => {
        store = await factory();
        await store.upsertUserLimits("test-user", { hardSpendLimitUsd: 100 });

        await store.incrementSpend("test-user", 0.75);
        await store.incrementSpend("test-user", 1.25);
        await store.incrementSpend("test-user", 0.50);

        const limits = await store.getUserLimits("test-user");
        if (!limits) throw new Error("expected user limits to exist");
        expect(limits.currentSpendUsd).toBeCloseTo(2.50);
      });

      test("does not throw for non-existent user", async () => {
        store = await factory();
        await expect(
          store.incrementSpend("nonexistent", 5.0),
        ).resolves.toBeUndefined();
      });
    });

    describe("Analytics", () => {
      test("getStats aggregates usage for a user within a period", async () => {
        store = await factory();
        const req1 = await store.createRequest(newRequest());
        const req2 = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());

        await store.updateRequest(req1.id, {
          status: "succeeded",
          batchId: batch.id,
        });
        await store.updateRequest(req2.id, {
          status: "failed",
          batchId: batch.id,
        });

        await store.createResult(
          newResult(req1.id, batch.id, {
            inputTokens: 100,
            outputTokens: 200,
          }),
        );

        const from = new Date(Date.now() - 3600_000);
        const to = new Date(Date.now() + 3600_000);
        const stats = await store.getStats("test-user", { from, to });

        expect(stats.totalRequests).toBe(2);
        expect(stats.succeededRequests).toBe(1);
        expect(stats.failedRequests).toBe(1);
        expect(stats.totalInputTokens).toBe(100);
        expect(stats.totalOutputTokens).toBe(200);
        expect(stats.totalBatches).toBe(1);
      });

      test("getStats returns zeros for unknown user", async () => {
        store = await factory();
        const from = new Date(Date.now() - 3600_000);
        const to = new Date(Date.now() + 3600_000);
        const stats = await store.getStats("unknown-user", { from, to });

        expect(stats.totalRequests).toBe(0);
        expect(stats.succeededRequests).toBe(0);
        expect(stats.failedRequests).toBe(0);
        expect(stats.totalInputTokens).toBe(0);
        expect(stats.totalOutputTokens).toBe(0);
        expect(stats.totalBatches).toBe(0);
      });

      test("getDetailedStats returns cost breakdown grouped by provider and model", async () => {
        store = await factory();
        const reqClaude = await store.createRequest(
          newRequest({ provider: "claude", model: "claude-sonnet-4-6" }),
        );
        const reqOpenai = await store.createRequest(
          newRequest({ provider: "openai", model: "gpt-4o" }),
        );
        const batch = await store.createBatch(newBatch());

        await store.updateRequest(reqClaude.id, {
          status: "succeeded",
          batchId: batch.id,
        });
        await store.updateRequest(reqOpenai.id, {
          status: "succeeded",
          batchId: batch.id,
        });

        await store.createResult(
          newResult(reqClaude.id, batch.id, {
            inputTokens: 1000,
            outputTokens: 500,
          }),
        );
        await store.createResult(
          newResult(reqOpenai.id, batch.id, {
            inputTokens: 2000,
            outputTokens: 1000,
          }),
        );

        const from = new Date(Date.now() - 3600_000);
        const to = new Date(Date.now() + 3600_000);
        const stats = await store.getDetailedStats("test-user", { from, to });

        expect(stats.totalRequests).toBe(2);
        expect(stats.costBreakdown.length).toBe(2);

        const claudeEntry = stats.costBreakdown.find(
          (e) => e.provider === "claude",
        );
        if (!claudeEntry) throw new Error("expected claude entry in cost breakdown");
        expect(claudeEntry.inputTokens).toBe(1000);
        expect(claudeEntry.outputTokens).toBe(500);
        expect(claudeEntry.requestCount).toBe(1);
        expect(claudeEntry.batchCostUsd).toBeGreaterThan(0);
        expect(claudeEntry.standardCostUsd).toBeGreaterThan(
          claudeEntry.batchCostUsd,
        );

        const openaiEntry = stats.costBreakdown.find(
          (e) => e.provider === "openai",
        );
        if (!openaiEntry) throw new Error("expected openai entry in cost breakdown");
        expect(openaiEntry.model).toBe("gpt-4o");

        expect(stats.totalSavingsUsd).toBeGreaterThan(0);
        expect(stats.totalStandardCostUsd).toBeCloseTo(
          stats.totalBatchCostUsd + stats.totalSavingsUsd,
          10,
        );
      });

      test("getDetailedStats returns zeros for empty data", async () => {
        store = await factory();
        const from = new Date(Date.now() - 3600_000);
        const to = new Date(Date.now() + 3600_000);
        const stats = await store.getDetailedStats("unknown-user", {
          from,
          to,
        });

        expect(stats.totalRequests).toBe(0);
        expect(stats.costBreakdown.length).toBe(0);
        expect(stats.avgTurnaroundMs).toBeNull();
        expect(stats.totalBatchCostUsd).toBe(0);
        expect(stats.totalStandardCostUsd).toBe(0);
        expect(stats.totalSavingsUsd).toBe(0);
      });

      test("getDetailedStats computes avg turnaround from completed batches", async () => {
        store = await factory();
        const req = await store.createRequest(newRequest());
        const batch = await store.createBatch(newBatch());

        const submitted = new Date(Date.now() - 60_000); // 60s ago
        const ended = new Date(); // now
        await store.updateRequest(req.id, {
          status: "succeeded",
          batchId: batch.id,
        });
        await store.updateBatch(batch.id, {
          status: "ended",
          submittedAt: submitted,
          endedAt: ended,
        });
        await store.createResult(
          newResult(req.id, batch.id, {
            inputTokens: 50,
            outputTokens: 100,
          }),
        );

        const from = new Date(Date.now() - 3600_000);
        const to = new Date(Date.now() + 3600_000);
        const stats = await store.getDetailedStats("test-user", { from, to });

        if (stats.avgTurnaroundMs == null) throw new Error("expected avgTurnaroundMs to be set");
        // Turnaround should be roughly 60000ms (allow some tolerance for clock drift).
        expect(stats.avgTurnaroundMs).toBeGreaterThan(50_000);
        expect(stats.avgTurnaroundMs).toBeLessThan(70_000);
      });
    });
  });
}
