/**
 * Retention worker tests.
 *
 * Tests all retention policy types, hard cap enforcement, event log scrubbing,
 * idempotency, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory.js";
import {
  RetentionWorker,
  parseRetentionPolicy,
  computeCutoffDate,
  DEFAULT_HARD_CAP_DAYS,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type RetentionPolicyResolver,
} from "../../engine/retention-worker.js";
import type { NewRequest, Request, Result, EventLogEntry } from "../../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNewRequest(overrides: Partial<NewRequest> = {}): NewRequest {
  return {
    provider: "claude",
    model: "claude-sonnet-4-6",
    params: {
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    },
    userId: "user_01",
    ...overrides,
  };
}

/**
 * Create a completed request with a result in the store.
 * Optionally mark the result as delivered.
 */
async function createCompletedRequest(
  store: MemoryStore,
  overrides: {
    userId?: string;
    callbackUrl?: string | null;
    delivered?: boolean;
    createdAt?: Date;
  } = {},
): Promise<{ request: Request; result: Result }> {
  const request = await store.createRequest(
    makeNewRequest({
      userId: overrides.userId ?? "user_01",
      callbackUrl: overrides.callbackUrl ?? null,
    }),
  );

  // Mark as succeeded.
  await store.updateRequest(request.id, { status: "succeeded" });

  const batch = await store.createBatch({
    provider: "claude",
    apiKeyId: overrides.userId ?? "user_01",
    requestCount: 1,
  });

  const result = await store.createResult({
    requestId: request.id,
    batchId: batch.id,
    response: { content: "Hello response", model: "claude-sonnet-4-6" },
    stopReason: "end_turn",
    inputTokens: 100,
    outputTokens: 50,
  });

  if (overrides.delivered) {
    await store.markDelivered(result.id);
  }

  // Backdate if requested (manipulate internal state for testing).
  if (overrides.createdAt) {
    // Access internal maps to set creation dates for time-based tests.
    // This is a test-only pattern used across the codebase.
    const reqRecord = (store as unknown as { requests: Map<string, Request> })
      .requests.get(request.id);
    if (reqRecord) {
      reqRecord.createdAt = overrides.createdAt;
      reqRecord.updatedAt = overrides.createdAt;
    }
    const resRecord = (store as unknown as { results: Map<string, Result> })
      .results.get(result.id);
    if (resRecord) {
      (resRecord as unknown as { createdAt: Date }).createdAt = overrides.createdAt;
    }
  }

  // Re-fetch to get current state.
  const updatedReq = await store.getRequest(request.id);
  if (!updatedReq) throw new Error("Request not found after setup");
  return {
    request: updatedReq,
    result: (await store.getUndeliveredResults(100)).find(
      (r) => r.id === result.id,
    ) ?? result,
  };
}

// ---------------------------------------------------------------------------
// parseRetentionPolicy
// ---------------------------------------------------------------------------

describe("parseRetentionPolicy", () => {
  it("parses 'on_ack' as 0 days", () => {
    expect(parseRetentionPolicy("on_ack")).toBe(0);
  });

  it("parses '1d' as 1 day", () => {
    expect(parseRetentionPolicy("1d")).toBe(1);
  });

  it("parses '7d' as 7 days", () => {
    expect(parseRetentionPolicy("7d")).toBe(7);
  });

  it("parses '30d' as 30 days", () => {
    expect(parseRetentionPolicy("30d")).toBe(30);
  });

  it("parses '90d' as 90 days", () => {
    expect(parseRetentionPolicy("90d")).toBe(90);
  });

  it("parses '120d' as 120 days (custom)", () => {
    expect(parseRetentionPolicy("120d")).toBe(120);
  });

  it("parses '0d' as 0 days", () => {
    expect(parseRetentionPolicy("0d")).toBe(0);
  });

  it("returns null for invalid policies", () => {
    expect(parseRetentionPolicy("invalid")).toBeNull();
    expect(parseRetentionPolicy("")).toBeNull();
    expect(parseRetentionPolicy("7")).toBeNull();
    expect(parseRetentionPolicy("d")).toBeNull();
    expect(parseRetentionPolicy("-1d")).toBeNull();
    expect(parseRetentionPolicy("7days")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeCutoffDate
// ---------------------------------------------------------------------------

describe("computeCutoffDate", () => {
  it("returns null for on_ack (0 days)", () => {
    expect(computeCutoffDate(0, 90)).toBeNull();
  });

  it("computes cutoff as now minus policy days", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const cutoff = computeCutoffDate(7, 90, now);
    expect(cutoff).toEqual(new Date("2026-01-08T00:00:00Z"));
  });

  it("clamps to operator hard cap when policy exceeds cap", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    // User wants 120d, operator cap is 90d => effective is 90d
    const cutoff = computeCutoffDate(120, 90, now);
    const expected = new Date(now.getTime() - 90 * MS_PER_DAY);
    expect(cutoff).toEqual(expected);
  });

  it("uses policy days when within hard cap", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const cutoff = computeCutoffDate(30, 90, now);
    const expected = new Date(now.getTime() - 30 * MS_PER_DAY);
    expect(cutoff).toEqual(expected);
  });

  it("clamps to hard cap of 1 day", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const cutoff = computeCutoffDate(30, 1, now);
    const expected = new Date(now.getTime() - 1 * MS_PER_DAY);
    expect(cutoff).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// RetentionWorker
// ---------------------------------------------------------------------------

describe("RetentionWorker", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Hard cap enforcement
  // -----------------------------------------------------------------------

  describe("hard cap enforcement", () => {
    it("scrubs content older than the hard cap", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 100 * MS_PER_DAY); // 100 days ago

      await createCompletedRequest(store, { createdAt: oldDate });

      const worker = new RetentionWorker({
        store,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.hardCapScrubbed).toBeGreaterThanOrEqual(1);
      expect(result.totalScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("does not scrub content within the hard cap", async () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 30 * MS_PER_DAY); // 30 days ago

      await createCompletedRequest(store, { createdAt: recentDate });

      const worker = new RetentionWorker({
        store,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.hardCapScrubbed).toBe(0);
    });

    it("uses default hard cap of 90 days", async () => {
      const now = new Date();
      const oldDate = new Date(
        now.getTime() - (DEFAULT_HARD_CAP_DAYS + 1) * MS_PER_DAY,
      );

      await createCompletedRequest(store, { createdAt: oldDate });

      const worker = new RetentionWorker({ store });

      const result = await worker.sweep(now);

      expect(result.hardCapScrubbed).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Per-user time-based policies
  // -----------------------------------------------------------------------

  describe("time-based policies", () => {
    it("scrubs content for '1d' policy after 1 day", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_1d",
        createdAt: twoDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = (userId) =>
        userId === "user_1d" ? "1d" : null;

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("does not scrub '7d' content that is only 3 days old", async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_7d",
        createdAt: threeDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = () => "7d";

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      // Should not be scrubbed by policy (only 3 days old, policy is 7d)
      // and not by hard cap (only 3 days old, cap is 90d).
      expect(result.policyScrubbed).toBe(0);
    });

    it("scrubs '7d' content that is 8 days old", async () => {
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_7d",
        createdAt: eightDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = () => "7d";

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("scrubs '30d' content that is 31 days old", async () => {
      const now = new Date();
      const thirtyOneDaysAgo = new Date(now.getTime() - 31 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_30d",
        createdAt: thirtyOneDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = () => "30d";

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("handles custom duration (14d)", async () => {
      const now = new Date();
      const fifteenDaysAgo = new Date(now.getTime() - 15 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_custom",
        createdAt: fifteenDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = () => "14d";

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("uses default policy when resolver returns null", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_default",
        createdAt: tenDaysAgo,
      });

      // Default policy is '7d', content is 10 days old -> should be scrubbed.
      const worker = new RetentionWorker({
        store,
        policyResolver: () => null,
        defaultPolicy: "7d",
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("clamps user policy to operator hard cap", async () => {
      const now = new Date();
      // Content is 50 days old. User wants 120d retention, but operator cap
      // is 45d, so content should be scrubbed.
      const fiftyDaysAgo = new Date(now.getTime() - 50 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_capped",
        createdAt: fiftyDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = () => "120d";

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 45,
      });

      const result = await worker.sweep(now);

      // Should be scrubbed: 50 days old > min(120, 45) = 45 days.
      expect(result.totalScrubbed).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // on_ack policy
  // -----------------------------------------------------------------------

  describe("on_ack policy", () => {
    it("scrubs delivered content immediately for on_ack users", async () => {
      await createCompletedRequest(store, {
        userId: "user_ack",
        delivered: true,
      });

      const policyResolver: RetentionPolicyResolver = (userId) =>
        userId === "user_ack" ? "on_ack" : null;

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep();

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("does not scrub undelivered content for on_ack users", async () => {
      // Create a request whose result is NOT delivered.
      await createCompletedRequest(store, {
        userId: "user_ack",
        delivered: false,
      });

      const policyResolver: RetentionPolicyResolver = () => "on_ack";

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep();

      // on_ack only scrubs delivered results.
      expect(result.policyScrubbed).toBe(0);
    });

    it("scrubs on_ack content regardless of age", async () => {
      // Create a very recent request that was just delivered.
      await createCompletedRequest(store, {
        userId: "user_ack",
        delivered: true,
      });

      const policyResolver: RetentionPolicyResolver = () => "on_ack";

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep();

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple users with different policies
  // -----------------------------------------------------------------------

  describe("multiple users with different policies", () => {
    it("applies different policies per user", async () => {
      const now = new Date();
      const fiveDaysAgo = new Date(now.getTime() - 5 * MS_PER_DAY);

      // user_1d has 1d policy -> 5-day-old content should be scrubbed
      await createCompletedRequest(store, {
        userId: "user_1d",
        createdAt: fiveDaysAgo,
      });

      // user_30d has 30d policy -> 5-day-old content should NOT be scrubbed
      await createCompletedRequest(store, {
        userId: "user_30d",
        createdAt: fiveDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = (userId) => {
        if (userId === "user_1d") return "1d";
        if (userId === "user_30d") return "30d";
        return null;
      };

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      // user_1d should be scrubbed (5 days > 1 day)
      // user_30d should NOT be scrubbed (5 days < 30 days)
      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);

      // Verify user_30d content is still present.
      const userIds = await store.getDistinctUserIdsWithUnscrubbedContent();
      expect(userIds).toContain("user_30d");
    });
  });

  // -----------------------------------------------------------------------
  // Tombstone format
  // -----------------------------------------------------------------------

  describe("tombstone format", () => {
    it("replaces params and response with tombstone including scrubbed_at", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      const { request } = await createCompletedRequest(store, {
        userId: "user_tombstone",
        createdAt: tenDaysAgo,
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      await worker.sweep(now);

      const scrubbedReq = await store.getRequest(request.id);
      expect(scrubbedReq).not.toBeNull();
      if (!scrubbedReq) return;
      expect(scrubbedReq.params).toMatchObject({ scrubbed: true });
      expect(scrubbedReq.params).toHaveProperty("scrubbed_at");
      expect(scrubbedReq.contentScrubbedAt).toBeInstanceOf(Date);

      // Token counts and metadata should be preserved.
      expect(scrubbedReq.id).toBe(request.id);
      expect(scrubbedReq.userId).toBe("user_tombstone");
      expect(scrubbedReq.status).toBe("succeeded");
      expect(scrubbedReq.provider).toBe("claude");
      expect(scrubbedReq.model).toBe("claude-sonnet-4-6");
    });

    it("preserves token counts after scrubbing", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      const { result } = await createCompletedRequest(store, {
        userId: "user_tokens",
        createdAt: tenDaysAgo,
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      await worker.sweep(now);

      // Verify token counts survived scrubbing.
      // Re-fetch the result. MemoryStore's results map retains the object.
      const results = (
        store as unknown as { results: Map<string, Result> }
      ).results;
      const scrubbedResult = results.get(result.id);
      expect(scrubbedResult).toBeDefined();
      if (!scrubbedResult) return;
      expect(scrubbedResult.inputTokens).toBe(100);
      expect(scrubbedResult.outputTokens).toBe(50);
      expect(scrubbedResult.response).toMatchObject({ scrubbed: true });
      expect(scrubbedResult.contentScrubbedAt).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------
  // Event log scrubbing
  // -----------------------------------------------------------------------

  describe("event log scrubbing", () => {
    it("scrubs event log details for scrubbed request entities", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      const { request } = await createCompletedRequest(store, {
        userId: "user_events",
        createdAt: tenDaysAgo,
      });

      // Log some events for this request.
      await store.logEvent({
        entityType: "request",
        entityId: request.id,
        event: "submitted",
        details: { provider: "claude", params: { sensitive: "data" } },
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.eventLogScrubbed).toBeGreaterThanOrEqual(1);

      // Verify event log details are scrubbed.
      const events = store.getEvents();
      const requestEvent = events.find(
        (e) => e.entityId === request.id && e.event === "submitted",
      );
      expect(requestEvent).toBeDefined();
      if (!requestEvent) return;
      expect(requestEvent.details).toMatchObject({ scrubbed: true });
    });

    it("does not scrub event log details for unscrubbed entities", async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * MS_PER_DAY);

      const { request } = await createCompletedRequest(store, {
        userId: "user_recent",
        createdAt: threeDaysAgo,
      });

      await store.logEvent({
        entityType: "request",
        entityId: request.id,
        event: "submitted",
        details: { provider: "claude", params: { sensitive: "data" } },
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      await worker.sweep(now);

      const events = store.getEvents();
      const requestEvent = events.find(
        (e) => e.entityId === request.id && e.event === "submitted",
      );
      expect(requestEvent).toBeDefined();
      if (!requestEvent) return;
      expect(requestEvent.details).toMatchObject({
        provider: "claude",
        params: { sensitive: "data" },
      });
    });

    it("scrubs event log entries with null details (no-op)", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      const { request } = await createCompletedRequest(store, {
        userId: "user_null_events",
        createdAt: tenDaysAgo,
      });

      // Log an event with null details.
      await store.logEvent({
        entityType: "request",
        entityId: request.id,
        event: "status_changed",
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      await worker.sweep(now);

      // Null details should not be counted as scrubbed.
      // The request and result are scrubbed, but the null-details event is not.
      const events = store.getEvents();
      const nullEvent = events.find(
        (e) => e.entityId === request.id && e.event === "status_changed",
      );
      expect(nullEvent).toBeDefined();
      if (!nullEvent) return;
      expect(nullEvent.details).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  describe("idempotency", () => {
    it("running sweep twice does not double-scrub", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_idem",
        createdAt: tenDaysAgo,
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      const result1 = await worker.sweep(now);
      expect(result1.totalScrubbed).toBeGreaterThanOrEqual(1);

      const result2 = await worker.sweep(now);
      expect(result2.totalScrubbed).toBe(0);
      expect(result2.hardCapScrubbed).toBe(0);
      expect(result2.policyScrubbed).toBe(0);
    });

    it("scrubbed records are not returned by getDistinctUserIdsWithUnscrubbedContent", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_idem2",
        createdAt: tenDaysAgo,
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      // Before sweep.
      let userIds = await store.getDistinctUserIdsWithUnscrubbedContent();
      expect(userIds).toContain("user_idem2");

      await worker.sweep(now);

      // After sweep — user should no longer appear.
      userIds = await store.getDistinctUserIdsWithUnscrubbedContent();
      expect(userIds).not.toContain("user_idem2");
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("counts errors for invalid policies", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_bad_policy",
        createdAt: tenDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = () =>
        "invalid_policy" as unknown as RetentionPolicy;

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.errors).toBeGreaterThanOrEqual(1);
    });

    it("continues processing other users when one user errors", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_good",
        createdAt: tenDaysAgo,
      });
      await createCompletedRequest(store, {
        userId: "user_error",
        createdAt: tenDaysAgo,
      });

      let _callCount = 0;
      const policyResolver: RetentionPolicyResolver = (userId) => {
        _callCount++;
        if (userId === "user_error") {
          throw new Error("Policy lookup failed");
        }
        return "7d";
      };

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      // One user should succeed, one should error.
      expect(result.errors).toBe(1);
      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });

    it("handles hard cap errors gracefully", async () => {
      // Create a store that throws on scrubExpiredContent.
      const brokenStore = {
        ...store,
        scrubExpiredContent: vi.fn().mockRejectedValue(new Error("DB error")),
        getDistinctUserIdsWithUnscrubbedContent: vi
          .fn()
          .mockResolvedValue([]),
        scrubEventLogsForScrubbedContent: vi.fn().mockResolvedValue(0),
      } as unknown as MemoryStore;

      const worker = new RetentionWorker({
        store: brokenStore,
        hardCapDays: 90,
      });

      const result = await worker.sweep();

      expect(result.errors).toBe(1);
      expect(result.hardCapScrubbed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Non-terminal requests
  // -----------------------------------------------------------------------

  describe("non-terminal requests", () => {
    it("does not scrub queued requests", async () => {
      const now = new Date();

      // Create a request that stays in 'queued' status.
      const request = await store.createRequest(
        makeNewRequest({ userId: "user_queued" }),
      );

      // Backdate it.
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);
      const reqRecord = (
        store as unknown as { requests: Map<string, Request> }
      ).requests.get(request.id);
      if (reqRecord) {
        reqRecord.createdAt = tenDaysAgo;
      }

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      await worker.sweep(now);

      const fetched = await store.getRequest(request.id);
      expect(fetched).not.toBeNull();
      if (!fetched) return;
      expect(fetched.contentScrubbedAt).toBeNull();
      expect(fetched.params).not.toMatchObject({ scrubbed: true });
    });

    it("does not scrub in-progress requests", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      const request = await store.createRequest(
        makeNewRequest({ userId: "user_processing" }),
      );
      await store.updateRequest(request.id, { status: "processing" });

      const reqRecord = (
        store as unknown as { requests: Map<string, Request> }
      ).requests.get(request.id);
      if (reqRecord) {
        reqRecord.createdAt = tenDaysAgo;
      }

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
      });

      await worker.sweep(now);

      const fetched = await store.getRequest(request.id);
      expect(fetched).not.toBeNull();
      if (!fetched) return;
      expect(fetched.contentScrubbedAt).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Async policy resolver
  // -----------------------------------------------------------------------

  describe("async policy resolver", () => {
    it("supports async policy resolution", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_async",
        createdAt: tenDaysAgo,
      });

      const policyResolver: RetentionPolicyResolver = async (userId) => {
        // Simulate async lookup (e.g., database query).
        await new Promise((resolve) => setTimeout(resolve, 1));
        return userId === "user_async" ? "1d" : null;
      };

      const worker = new RetentionWorker({
        store,
        policyResolver,
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Start / stop lifecycle
  // -----------------------------------------------------------------------

  describe("start / stop lifecycle", () => {
    it("starts and stops the interval timer", () => {
      vi.useFakeTimers();

      const worker = new RetentionWorker({
        store,
        intervalMs: 1000,
      });

      worker.start();
      // Starting again should be a no-op.
      worker.start();

      worker.stop();
      // Stopping again should be a no-op.
      worker.stop();

      vi.useRealTimers();
    });

    it("calls sweep periodically when started", async () => {
      vi.useFakeTimers();

      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_periodic",
        createdAt: tenDaysAgo,
      });

      const worker = new RetentionWorker({
        store,
        policyResolver: () => "7d",
        hardCapDays: 90,
        intervalMs: 1000,
      });

      // Spy on scrubExpiredContent to verify it gets called.
      const spy = vi.spyOn(store, "scrubExpiredContent");

      worker.start();

      // Advance past the interval.
      await vi.advanceTimersByTimeAsync(1100);

      expect(spy).toHaveBeenCalled();

      worker.stop();
      vi.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // Telemetry
  // -----------------------------------------------------------------------

  describe("telemetry", () => {
    it("emits telemetry events during sweep", async () => {
      const now = new Date();
      const hundredDaysAgo = new Date(now.getTime() - 100 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_telemetry",
        createdAt: hundredDaysAgo,
      });

      const eventSpy = vi.fn();
      const counterSpy = vi.fn();
      const telemetry = {
        counter: counterSpy,
        histogram: vi.fn(),
        event: eventSpy,
      };

      const worker = new RetentionWorker({
        store,
        hardCapDays: 90,
        telemetry,
      });

      await worker.sweep(now);

      // Should have emitted at least a hard_cap event and a sweep_complete event.
      expect(eventSpy).toHaveBeenCalledWith(
        "retention_hard_cap",
        expect.objectContaining({ scrubbed: expect.any(Number) }),
      );
      expect(eventSpy).toHaveBeenCalledWith(
        "retention_sweep_complete",
        expect.objectContaining({
          totalScrubbed: expect.any(Number),
          hardCapScrubbed: expect.any(Number),
        }),
      );
    });

    it("does not emit sweep_complete when nothing was scrubbed", async () => {
      const eventSpy = vi.fn();
      const telemetry = {
        counter: vi.fn(),
        histogram: vi.fn(),
        event: eventSpy,
      };

      const worker = new RetentionWorker({
        store,
        hardCapDays: 90,
        telemetry,
      });

      await worker.sweep();

      // No content to scrub, so sweep_complete should not be emitted.
      expect(eventSpy).not.toHaveBeenCalledWith(
        "retention_sweep_complete",
        expect.anything(),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Default policy
  // -----------------------------------------------------------------------

  describe("default policy", () => {
    it("uses DEFAULT_RETENTION_POLICY when not configured", () => {
      expect(DEFAULT_RETENTION_POLICY).toBe("7d");
    });

    it("respects custom default policy", async () => {
      const now = new Date();
      const fourDaysAgo = new Date(now.getTime() - 4 * MS_PER_DAY);

      await createCompletedRequest(store, {
        userId: "user_custom_default",
        createdAt: fourDaysAgo,
      });

      // Default policy is '3d', content is 4 days old -> should be scrubbed.
      const worker = new RetentionWorker({
        store,
        defaultPolicy: "3d",
        hardCapDays: 90,
      });

      const result = await worker.sweep(now);

      expect(result.policyScrubbed).toBeGreaterThanOrEqual(1);
    });
  });
});
