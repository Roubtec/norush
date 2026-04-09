/**
 * Dashboard stats tests.
 *
 * Verifies stats aggregation correctness (request counts, token sums, cost
 * calculation), period filtering, empty data returns zeroes, cost breakdown
 * groups by provider and model, and savings calculation matches expected formula.
 *
 * Uses the MemoryStore from @norush/core as the backing store, since the
 * aggregation logic is tested at the store level and the dashboard reads
 * from that same interface.
 */

import { describe, it, expect } from "vitest";
import {
  MemoryStore,
  standardCost,
  batchCost,
  pricingSavings,
  BATCH_DISCOUNT,
  STANDARD_RATES,
  getRates,
} from "@norush/core";
import type { NewRequest } from "@norush/core";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function newRequest(overrides?: Partial<NewRequest>): NewRequest {
  return {
    provider: "claude",
    model: "claude-sonnet-4-6",
    params: { messages: [{ role: "user", content: "Hello" }] },
    userId: "user-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stats aggregation correctness
// ---------------------------------------------------------------------------

describe("Dashboard stats aggregation", () => {
  it("counts requests, tokens, and batches correctly", async () => {
    const store = new MemoryStore();

    const r1 = await store.createRequest(newRequest());
    const r2 = await store.createRequest(newRequest());
    const batch = await store.createBatch({
      provider: "claude",
      apiKeyId: "key-1",
      requestCount: 2,
    });

    await store.updateRequest(r1.id, {
      status: "succeeded",
      batchId: batch.id,
    });
    await store.updateRequest(r2.id, {
      status: "failed",
      batchId: batch.id,
    });

    await store.createResult({
      requestId: r1.id,
      batchId: batch.id,
      response: {},
      inputTokens: 500,
      outputTokens: 200,
    });

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    expect(stats.totalRequests).toBe(2);
    expect(stats.succeededRequests).toBe(1);
    expect(stats.failedRequests).toBe(1);
    expect(stats.totalInputTokens).toBe(500);
    expect(stats.totalOutputTokens).toBe(200);
    expect(stats.totalBatches).toBe(1);
  });

  it("aggregates tokens from multiple results", async () => {
    const store = new MemoryStore();

    const r1 = await store.createRequest(newRequest());
    const r2 = await store.createRequest(newRequest());
    const batch = await store.createBatch({
      provider: "claude",
      apiKeyId: "key-1",
      requestCount: 2,
    });

    await store.updateRequest(r1.id, {
      status: "succeeded",
      batchId: batch.id,
    });
    await store.updateRequest(r2.id, {
      status: "succeeded",
      batchId: batch.id,
    });

    await store.createResult({
      requestId: r1.id,
      batchId: batch.id,
      response: {},
      inputTokens: 1000,
      outputTokens: 500,
    });
    await store.createResult({
      requestId: r2.id,
      batchId: batch.id,
      response: {},
      inputTokens: 2000,
      outputTokens: 1000,
    });

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    expect(stats.totalInputTokens).toBe(3000);
    expect(stats.totalOutputTokens).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// Period filtering
// ---------------------------------------------------------------------------

describe("Period filtering", () => {
  it("returns only requests within the date range", async () => {
    const store = new MemoryStore();

    // Create a request and backdate it to 10 days ago so it falls outside the
    // last-hour query window.
    const old = await store.createRequest(newRequest());
    await store.updateRequest(old.id, {
      status: "succeeded",
      createdAt: new Date(Date.now() - 10 * 86_400_000),
    });

    // Create a recent request that should appear in the last-hour window.
    const recent = await store.createRequest(newRequest());
    await store.updateRequest(recent.id, { status: "succeeded" });

    // Query for the last hour only — only the recent request should appear.
    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    expect(stats.totalRequests).toBe(1);

    // Query for a future window — should return 0.
    const futureFrom = new Date(Date.now() + 86_400_000);
    const futureTo = new Date(Date.now() + 2 * 86_400_000);
    const emptyStats = await store.getDetailedStats("user-1", {
      from: futureFrom,
      to: futureTo,
    });
    expect(emptyStats.totalRequests).toBe(0);
  });

  it("24h period returns only recent data", async () => {
    const store = new MemoryStore();

    await store.createRequest(newRequest());

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const stats = await store.getDetailedStats("user-1", {
      from: twentyFourHoursAgo,
      to: now,
    });

    expect(stats.totalRequests).toBe(1);
  });

  it("7d period returns data from the last week", async () => {
    const store = new MemoryStore();

    await store.createRequest(newRequest());

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const stats = await store.getDetailedStats("user-1", {
      from: sevenDaysAgo,
      to: now,
    });

    expect(stats.totalRequests).toBe(1);
  });

  it("30d period returns data from the last month", async () => {
    const store = new MemoryStore();

    await store.createRequest(newRequest());

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const stats = await store.getDetailedStats("user-1", {
      from: thirtyDaysAgo,
      to: now,
    });

    expect(stats.totalRequests).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty data
// ---------------------------------------------------------------------------

describe("Empty data handling", () => {
  it("returns all zeroes for a user with no activity", async () => {
    const store = new MemoryStore();

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    expect(stats.totalRequests).toBe(0);
    expect(stats.succeededRequests).toBe(0);
    expect(stats.failedRequests).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalBatches).toBe(0);
    expect(stats.costBreakdown).toEqual([]);
    expect(stats.avgTurnaroundMs).toBeNull();
    expect(stats.totalBatchCostUsd).toBe(0);
    expect(stats.totalStandardCostUsd).toBe(0);
    expect(stats.totalSavingsUsd).toBe(0);
  });

  it("returns zeroes for an unknown user", async () => {
    const store = new MemoryStore();

    // Add data for a different user.
    await store.createRequest(newRequest({ userId: "other-user" }));

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    expect(stats.totalRequests).toBe(0);
    expect(stats.costBreakdown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost breakdown grouping
// ---------------------------------------------------------------------------

describe("Cost breakdown by provider and model", () => {
  it("groups costs by provider and model", async () => {
    const store = new MemoryStore();
    const batch = await store.createBatch({
      provider: "claude",
      apiKeyId: "key-1",
      requestCount: 3,
    });

    // Two Claude requests with different models.
    const r1 = await store.createRequest(
      newRequest({ provider: "claude", model: "claude-sonnet-4-6" }),
    );
    const r2 = await store.createRequest(
      newRequest({ provider: "claude", model: "claude-haiku-3" }),
    );
    // One OpenAI request.
    const r3 = await store.createRequest(
      newRequest({ provider: "openai", model: "gpt-4o" }),
    );

    for (const r of [r1, r2, r3]) {
      await store.updateRequest(r.id, {
        status: "succeeded",
        batchId: batch.id,
      });
    }

    await store.createResult({
      requestId: r1.id,
      batchId: batch.id,
      response: {},
      inputTokens: 1000,
      outputTokens: 500,
    });
    await store.createResult({
      requestId: r2.id,
      batchId: batch.id,
      response: {},
      inputTokens: 2000,
      outputTokens: 1000,
    });
    await store.createResult({
      requestId: r3.id,
      batchId: batch.id,
      response: {},
      inputTokens: 3000,
      outputTokens: 1500,
    });

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    // Should have 3 groups: claude/claude-sonnet-4-6, claude/claude-haiku-3, openai/gpt-4o.
    expect(stats.costBreakdown.length).toBe(3);

    const sonnetEntry = stats.costBreakdown.find(
      (e) => e.provider === "claude" && e.model === "claude-sonnet-4-6",
    );
    if (!sonnetEntry) throw new Error("expected claude-sonnet-4-6 entry");
    expect(sonnetEntry.inputTokens).toBe(1000);
    expect(sonnetEntry.outputTokens).toBe(500);
    expect(sonnetEntry.requestCount).toBe(1);

    const haikuEntry = stats.costBreakdown.find(
      (e) => e.provider === "claude" && e.model === "claude-haiku-3",
    );
    if (!haikuEntry) throw new Error("expected claude-haiku-3 entry");
    expect(haikuEntry.inputTokens).toBe(2000);
    expect(haikuEntry.outputTokens).toBe(1000);

    const openaiEntry = stats.costBreakdown.find(
      (e) => e.provider === "openai",
    );
    if (!openaiEntry) throw new Error("expected openai entry");
    expect(openaiEntry.model).toBe("gpt-4o");
    expect(openaiEntry.inputTokens).toBe(3000);
    expect(openaiEntry.outputTokens).toBe(1500);
  });

  it("calculates per-entry batch and standard costs", async () => {
    const store = new MemoryStore();
    const batch = await store.createBatch({
      provider: "claude",
      apiKeyId: "key-1",
      requestCount: 1,
    });

    const r1 = await store.createRequest(
      newRequest({ provider: "claude", model: "claude-sonnet-4-6" }),
    );
    await store.updateRequest(r1.id, {
      status: "succeeded",
      batchId: batch.id,
    });
    await store.createResult({
      requestId: r1.id,
      batchId: batch.id,
      response: {},
      inputTokens: 10000,
      outputTokens: 5000,
    });

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    const entry = stats.costBreakdown[0];
    expect(entry).toBeDefined();

    // Verify cost calculations match the pricing module.
    const expectedStandard = standardCost("claude", 10000, 5000);
    const expectedBatch = batchCost("claude", 10000, 5000);

    expect(entry.standardCostUsd).toBeCloseTo(expectedStandard, 10);
    expect(entry.batchCostUsd).toBeCloseTo(expectedBatch, 10);
    expect(entry.standardCostUsd).toBeGreaterThan(entry.batchCostUsd);
  });
});

// ---------------------------------------------------------------------------
// Savings calculation
// ---------------------------------------------------------------------------

describe("Savings calculation", () => {
  it("savings equals standard minus batch cost", async () => {
    const store = new MemoryStore();
    const batch = await store.createBatch({
      provider: "claude",
      apiKeyId: "key-1",
      requestCount: 1,
    });

    const r1 = await store.createRequest(newRequest());
    await store.updateRequest(r1.id, {
      status: "succeeded",
      batchId: batch.id,
    });
    await store.createResult({
      requestId: r1.id,
      batchId: batch.id,
      response: {},
      inputTokens: 100_000,
      outputTokens: 50_000,
    });

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    expect(stats.totalSavingsUsd).toBeCloseTo(
      stats.totalStandardCostUsd - stats.totalBatchCostUsd,
      10,
    );
    // Savings should be 50% of standard cost.
    expect(stats.totalSavingsUsd).toBeCloseTo(
      stats.totalStandardCostUsd * 0.5,
      10,
    );
  });

  it("pricing module matches expected formula", () => {
    // Claude: $3/M input, $15/M output
    const std = standardCost("claude", 1_000_000, 1_000_000);
    expect(std).toBeCloseTo(3.0 + 15.0, 5);

    const batch = batchCost("claude", 1_000_000, 1_000_000);
    expect(batch).toBeCloseTo((3.0 + 15.0) * 0.5, 5);

    const saved = pricingSavings("claude", 1_000_000, 1_000_000);
    expect(saved).toBeCloseTo((3.0 + 15.0) * 0.5, 5);
  });

  it("batch discount is 50%", () => {
    expect(BATCH_DISCOUNT).toBe(0.5);
  });

  it("getRates falls back to claude for unknown providers", () => {
    const rates = getRates("unknown");
    expect(rates).toEqual(STANDARD_RATES.claude);
  });

  it("openai rates differ from claude rates", () => {
    const claude = getRates("claude");
    const openai = getRates("openai");
    expect(claude.input).not.toBe(openai.input);
  });
});

// ---------------------------------------------------------------------------
// Batch turnaround
// ---------------------------------------------------------------------------

describe("Batch turnaround", () => {
  it("computes average turnaround for completed batches", async () => {
    const store = new MemoryStore();

    const r1 = await store.createRequest(newRequest());
    const batch = await store.createBatch({
      provider: "claude",
      apiKeyId: "key-1",
      requestCount: 1,
    });
    await store.updateRequest(r1.id, {
      status: "succeeded",
      batchId: batch.id,
    });

    const submitted = new Date(Date.now() - 120_000); // 2 min ago
    const ended = new Date(); // now
    await store.updateBatch(batch.id, {
      status: "ended",
      submittedAt: submitted,
      endedAt: ended,
    });

    await store.createResult({
      requestId: r1.id,
      batchId: batch.id,
      response: {},
      inputTokens: 100,
      outputTokens: 50,
    });

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    if (stats.avgTurnaroundMs == null) throw new Error("expected avgTurnaroundMs to be set");
    expect(stats.avgTurnaroundMs).toBeGreaterThan(100_000);
    expect(stats.avgTurnaroundMs).toBeLessThan(140_000);
  });

  it("returns null turnaround when no batches are completed", async () => {
    const store = new MemoryStore();

    await store.createRequest(newRequest());

    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const stats = await store.getDetailedStats("user-1", { from, to });

    expect(stats.avgTurnaroundMs).toBeNull();
  });
});
