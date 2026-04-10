/**
 * Tests for the /api/v1/requests route handlers.
 *
 * Tests request submission validation, pagination parameters,
 * and filter validation. Uses mocked SQL and engine.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockEnqueue = vi.fn();
const mockFlush = vi.fn();
const mockGetUserLimits = vi.fn().mockResolvedValue(null);
const mockGetSlidingWindow = vi.fn().mockResolvedValue({ total: 0, succeeded: 0, failed: 0 });
const mockIncrementPeriodRequests = vi.fn().mockResolvedValue(undefined);
const mockConsumePeriodRequests = vi.fn().mockResolvedValue(true);
const mockResetPeriod = vi.fn().mockResolvedValue(undefined);

vi.mock("$lib/server/norush", () => ({
  getSql: () => mockSql,
  getEngine: () => Promise.resolve({ enqueue: mockEnqueue, flush: mockFlush }),
  getStore: () => ({
    getUserLimits: mockGetUserLimits,
    getSlidingWindow: mockGetSlidingWindow,
    incrementPeriodRequests: mockIncrementPeriodRequests,
    consumePeriodRequests: mockConsumePeriodRequests,
    resetPeriod: mockResetPeriod,
  }),
}));

vi.mock("$lib/server/api-auth", () => ({
  authenticateApiRequest: (_sql: unknown, authHeader: string | null) => {
    if (authHeader === "Bearer valid_token") {
      return Promise.resolve({ userId: "user_01", tokenId: "tok_01" });
    }
    return Promise.resolve(null);
  },
}));

// ---------------------------------------------------------------------------
// Mock SQL
// ---------------------------------------------------------------------------

let mockSqlResult: Record<string, unknown>[] = [];

const mockSql = new Proxy(
  (() => {
    /* noop */
  }) as unknown as import("postgres").Sql,
  {
    apply: () => {
      const rows = [...mockSqlResult];
      return Promise.resolve(Object.assign(rows, { count: rows.length }));
    },
  },
);

// ---------------------------------------------------------------------------
// Import handlers
// ---------------------------------------------------------------------------

import { POST, GET } from "../../../src/routes/api/v1/requests/+server";
import { GET as getRequestById } from "../../../src/routes/api/v1/requests/[id]/+server";
import { POST as redeliverPost } from "../../../src/routes/api/v1/requests/[id]/redeliver/+server";
import { POST as retryPost } from "../../../src/routes/api/v1/requests/[id]/retry/+server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(
  method: string,
  body?: unknown,
  authHeader = "Bearer valid_token",
  searchParams?: URLSearchParams,
): { request: Request; locals: Record<string, unknown>; url: URL } {
  const url = new URL("http://localhost/api/v1/requests");
  if (searchParams) {
    searchParams.forEach((v, k) => url.searchParams.set(k, v));
  }

  const headers = new Headers();
  if (authHeader) {
    headers.set("authorization", authHeader);
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const request = new Request(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return { request, locals: {}, url };
}

// SvelteKit RequestEvent adapter
function makeEvent(
  method: string,
  body?: unknown,
  authHeader?: string,
  searchParams?: URLSearchParams,
) {
  const { request, url } = createRequest(method, body, authHeader, searchParams);
  return {
    request,
    url,
    locals: {},
    params: {},
    cookies: {} as never,
    getClientAddress: () => "127.0.0.1",
    isDataRequest: false,
    isSubRequest: false,
    platform: undefined,
    route: { id: "/api/v1/requests" },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

// SvelteKit RequestEvent adapter for single-request endpoint
function makeSingleEvent(id: string, authHeader = "Bearer valid_token") {
  const url = new URL(`http://localhost/api/v1/requests/${id}`);

  return {
    request: new Request(url.toString(), {
      method: "GET",
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    url,
    locals: {},
    params: { id },
    cookies: {} as never,
    getClientAddress: () => "127.0.0.1",
    isDataRequest: false,
    isSubRequest: false,
    platform: undefined,
    route: { id: "/api/v1/requests/[id]" },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockSqlResult = [];
  mockEnqueue.mockResolvedValue({
    id: "req_01",
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    status: "queued",
    createdAt: new Date("2025-06-15T10:00:00Z"),
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/requests
// ---------------------------------------------------------------------------

describe("POST /api/v1/requests", () => {
  it("rejects unauthenticated requests", async () => {
    const event = makeEvent("POST", { provider: "claude", model: "test", params: {} }, "");
    const response = await POST(event as never);
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("rejects requests with invalid Bearer token", async () => {
    const event = makeEvent("POST", { provider: "claude", model: "test", params: {} }, "Bearer invalid");
    const response = await POST(event as never);
    expect(response.status).toBe(401);
  });

  it("rejects invalid JSON body", async () => {
    const url = new URL("http://localhost/api/v1/requests");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: {
        authorization: "Bearer valid_token",
        "content-type": "application/json",
      },
      body: "not json",
    });

    const event = {
      request,
      url,
      locals: {},
      params: {},
      cookies: {} as never,
      getClientAddress: () => "127.0.0.1",
      isDataRequest: false,
      isSubRequest: false,
      platform: undefined,
      route: { id: "/api/v1/requests" },
      fetch: globalThis.fetch,
      setHeaders: vi.fn(),
    };

    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("invalid_json");
  });

  it("creates a single request successfully", async () => {
    const event = makeEvent("POST", {
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      params: { messages: [{ role: "user", content: "Hello" }] },
    });

    const response = await POST(event as never);
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.request).toBeDefined();
    expect(data.request.id).toBe("req_01");
    expect(data.request.status).toBe("queued");
  });

  it("creates bulk requests and returns array", async () => {
    const event = makeEvent("POST", [
      { provider: "claude", model: "claude-sonnet-4-20250514", params: { messages: [] } },
      { provider: "openai", model: "gpt-4o", params: { messages: [] } },
    ]);

    const response = await POST(event as never);
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.requests).toBeDefined();
    expect(data.requests).toHaveLength(2);
  });

  it("rejects empty array", async () => {
    const event = makeEvent("POST", []);
    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("empty_request");
  });

  it("validates required provider field", async () => {
    const event = makeEvent("POST", { model: "test", params: {} });
    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("validation_error");
    expect(data.error.details.some((e: { field: string }) => e.field === "provider")).toBe(true);
  });

  it("validates required model field", async () => {
    const event = makeEvent("POST", { provider: "claude", params: {} });
    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.details.some((e: { field: string }) => e.field === "model")).toBe(true);
  });

  it("validates params must be an object", async () => {
    const event = makeEvent("POST", { provider: "claude", model: "test", params: "invalid" });
    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.details.some((e: { field: string }) => e.field === "params")).toBe(true);
  });

  it("rejects invalid provider", async () => {
    const event = makeEvent("POST", { provider: "google", model: "test", params: {} });
    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.details.some((e: { field: string }) => e.field === "provider")).toBe(true);
  });

  it("accepts optional callback_url and webhook_secret", async () => {
    const event = makeEvent("POST", {
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      params: { messages: [] },
      callback_url: "https://example.com/hook",
      webhook_secret: "secret123",
    });

    const response = await POST(event as never);
    expect(response.status).toBe(201);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: "https://example.com/hook",
        webhookSecret: "secret123",
      }),
    );
  });

  it("indicates item index in bulk validation errors", async () => {
    const event = makeEvent("POST", [
      { provider: "claude", model: "test", params: {} },
      { provider: "invalid", model: "test", params: {} },
    ]);

    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("item 1");
  });

  it("rejects more than 100 requests", async () => {
    const items = Array.from({ length: 101 }, () => ({
      provider: "claude",
      model: "test",
      params: {},
    }));
    const event = makeEvent("POST", items);
    const response = await POST(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("too_many_requests");
  });

  it("returns rate limit headers on allowed requests", async () => {
    mockGetUserLimits.mockResolvedValueOnce({
      userId: "user_01",
      maxRequestsPerHour: 100,
      maxTokensPerPeriod: null,
      hardSpendLimitUsd: null,
      currentPeriodRequests: 10,
      currentPeriodTokens: 0,
      currentSpendUsd: 0,
      periodResetAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetSlidingWindow.mockResolvedValueOnce({ total: 10, succeeded: 10, failed: 0 });

    const event = makeEvent("POST", {
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      params: { messages: [{ role: "user", content: "Hello" }] },
    });

    const response = await POST(event as never);
    expect(response.status).toBe(201);
    expect(response.headers.get("X-Norush-Health")).toBe("healthy");
    expect(response.headers.get("X-Norush-Effective-Limit")).toBe("100");
  });

  it("returns 429 when request limit is exceeded", async () => {
    mockGetUserLimits.mockResolvedValueOnce({
      userId: "user_01",
      maxRequestsPerHour: 10,
      maxTokensPerPeriod: null,
      hardSpendLimitUsd: null,
      currentPeriodRequests: 10,
      currentPeriodTokens: 0,
      currentSpendUsd: 0,
      periodResetAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetSlidingWindow.mockResolvedValueOnce({ total: 0, succeeded: 0, failed: 0 });

    const event = makeEvent("POST", {
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      params: { messages: [{ role: "user", content: "Hello" }] },
    });

    const response = await POST(event as never);
    expect(response.status).toBe(429);

    const data = await response.json();
    expect(data.error.code).toBe("rate_limited");
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(response.headers.get("X-Norush-Health")).toBe("healthy");
    expect(response.headers.get("X-Norush-Effective-Limit")).toBe("10");
  });

  it("returns 429 when hard spend limit is exceeded", async () => {
    mockGetUserLimits.mockResolvedValueOnce({
      userId: "user_01",
      maxRequestsPerHour: null,
      maxTokensPerPeriod: null,
      hardSpendLimitUsd: 10.0,
      currentPeriodRequests: 0,
      currentPeriodTokens: 0,
      currentSpendUsd: 10.0,
      periodResetAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetSlidingWindow.mockResolvedValueOnce({ total: 0, succeeded: 0, failed: 0 });

    const event = makeEvent("POST", {
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      params: {},
    });

    const response = await POST(event as never);
    expect(response.status).toBe(429);

    const data = await response.json();
    expect(data.error.code).toBe("rate_limited");
    expect(data.error.message).toContain("Hard spend limit");
  });

  it("returns 429 when atomic consume rejects due to concurrent capacity exhaustion", async () => {
    // checkRateLimit says "allowed" (limits configured, capacity looks fine),
    // but consumePeriodRequests returns false — another concurrent request
    // consumed the remaining capacity between check and consume.
    mockGetUserLimits.mockResolvedValueOnce({
      userId: "user_01",
      maxRequestsPerHour: 10,
      maxTokensPerPeriod: null,
      hardSpendLimitUsd: null,
      currentPeriodRequests: 5,
      currentPeriodTokens: 0,
      currentSpendUsd: 0,
      periodResetAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetSlidingWindow.mockResolvedValueOnce({ total: 0, succeeded: 0, failed: 0 });
    mockConsumePeriodRequests.mockResolvedValueOnce(false);

    const event = makeEvent("POST", {
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      params: { messages: [{ role: "user", content: "Hello" }] },
    });

    const response = await POST(event as never);
    expect(response.status).toBe(429);

    const data = await response.json();
    expect(data.error.code).toBe("rate_limited");
    expect(data.error.message).toContain("request_limit_exceeded");

    // Verify consumePeriodRequests was actually called with the right args
    expect(mockConsumePeriodRequests).toHaveBeenCalledWith("user_01", 1, 10);

    // Verify enqueue was never called (request should be rejected before enqueuing)
    expect(mockEnqueue).not.toHaveBeenCalled();

    // Retry-After must be present so clients know when to retry
    const retryAfter = response.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("rejects bulk submission that would exceed the rate limit", async () => {
    mockGetUserLimits.mockResolvedValueOnce({
      userId: "user_01",
      maxRequestsPerHour: 10,
      maxTokensPerPeriod: null,
      hardSpendLimitUsd: null,
      currentPeriodRequests: 8,
      currentPeriodTokens: 0,
      currentSpendUsd: 0,
      periodResetAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGetSlidingWindow.mockResolvedValueOnce({ total: 0, succeeded: 0, failed: 0 });

    // 8 already used + 5 new = 13 > 10
    const items = Array.from({ length: 5 }, () => ({
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      params: {},
    }));
    const event = makeEvent("POST", items);

    const response = await POST(event as never);
    expect(response.status).toBe(429);

    const data = await response.json();
    expect(data.error.code).toBe("rate_limited");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/requests
// ---------------------------------------------------------------------------

describe("GET /api/v1/requests", () => {
  it("rejects unauthenticated requests", async () => {
    const event = makeEvent("GET", undefined, "");
    const response = await GET(event as never);
    expect(response.status).toBe(401);
  });

  it("returns paginated request list", async () => {
    const now = new Date("2025-06-15T10:00:00Z");
    mockSqlResult = [
      {
        id: "req_01",
        provider: "claude",
        model: "claude-sonnet-4-20250514",
        status: "queued",
        batch_id: null,
        callback_url: null,
        retry_count: 0,
        max_retries: 5,
        created_at: now,
        updated_at: now,
      },
    ];

    const event = makeEvent("GET");
    const response = await GET(event as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0].id).toBe("req_01");
    expect(data.pagination).toBeDefined();
    expect(data.pagination.hasMore).toBe(false);
  });

  it("rejects invalid status filter", async () => {
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ status: "invalid" }));
    const response = await GET(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("invalid_filter");
  });

  it("rejects invalid provider filter", async () => {
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ provider: "google" }));
    const response = await GET(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("invalid_filter");
  });

  it("accepts valid status filter", async () => {
    mockSqlResult = [];
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ status: "queued" }));
    const response = await GET(event as never);
    expect(response.status).toBe(200);
  });

  it("accepts valid provider filter", async () => {
    mockSqlResult = [];
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ provider: "claude" }));
    const response = await GET(event as never);
    expect(response.status).toBe(200);
  });

  it("respects limit parameter", async () => {
    mockSqlResult = [];
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ limit: "10" }));
    const response = await GET(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(10);
  });

  it("clamps limit to maximum of 100", async () => {
    mockSqlResult = [];
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ limit: "500" }));
    const response = await GET(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(100);
  });

  it("clamps limit=0 to minimum of 1", async () => {
    mockSqlResult = [];
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ limit: "0" }));
    const response = await GET(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(1);
  });

  it("defaults limit to 50 for non-numeric input", async () => {
    mockSqlResult = [];
    const event = makeEvent("GET", undefined, "Bearer valid_token", new URLSearchParams({ limit: "abc" }));
    const response = await GET(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(50);
  });

  it("defaults limit to 50", async () => {
    mockSqlResult = [];
    const event = makeEvent("GET");
    const response = await GET(event as never);
    const data = await response.json();
    expect(data.pagination.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/requests/:id (single request detail)
// ---------------------------------------------------------------------------

describe("GET /api/v1/requests/:id", () => {
  it("rejects unauthenticated requests (no token)", async () => {
    const event = makeSingleEvent("req_01", "");
    const response = await getRequestById(event as never);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("rejects requests with invalid Bearer token", async () => {
    const event = makeSingleEvent("req_01", "Bearer invalid_token");
    const response = await getRequestById(event as never);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("returns 404 for non-existent request", async () => {
    mockSqlResult = [];
    const event = makeSingleEvent("req_nonexistent");
    const response = await getRequestById(event as never);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("not_found");
  });

  it("returns 404 when request belongs to another user (empty result)", async () => {
    // The SQL query filters by user_id, so a request owned by another user
    // yields zero rows, indistinguishable from non-existent.
    mockSqlResult = [];
    const event = makeSingleEvent("req_other_user");
    const response = await getRequestById(event as never);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("not_found");
  });

  it("returns request with result when result exists", async () => {
    const reqCreated = new Date("2025-06-15T10:00:00Z");
    const reqUpdated = new Date("2025-06-15T10:05:00Z");
    const resCreated = new Date("2025-06-15T10:04:00Z");

    mockSqlResult = [
      {
        id: "req_01",
        provider: "claude",
        model: "claude-sonnet-4-20250514",
        params: { messages: [{ role: "user", content: "Hello" }] },
        status: "succeeded",
        batch_id: "batch_01",
        callback_url: "https://example.com/hook",
        retry_count: 0,
        max_retries: 5,
        request_created_at: reqCreated,
        request_updated_at: reqUpdated,
        result_id: "res_01",
        response: { content: [{ type: "text", text: "Hi there!" }] },
        stop_reason: "end_turn",
        input_tokens: 10,
        output_tokens: 5,
        delivery_status: "delivered",
        result_created_at: resCreated,
      },
    ];

    const event = makeSingleEvent("req_01");
    const response = await getRequestById(event as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.request).toBeDefined();
    expect(data.request.id).toBe("req_01");
    expect(data.request.provider).toBe("claude");
    expect(data.request.model).toBe("claude-sonnet-4-20250514");
    expect(data.request.params).toEqual({ messages: [{ role: "user", content: "Hello" }] });
    expect(data.request.status).toBe("succeeded");
    expect(data.request.batchId).toBe("batch_01");
    expect(data.request.callbackUrl).toBe("https://example.com/hook");
    expect(data.request.retryCount).toBe(0);
    expect(data.request.maxRetries).toBe(5);
    expect(data.request.createdAt).toBe(reqCreated.toISOString());
    expect(data.request.updatedAt).toBe(reqUpdated.toISOString());

    // Verify joined result data
    expect(data.request.result).not.toBeNull();
    expect(data.request.result.id).toBe("res_01");
    expect(data.request.result.response).toEqual({ content: [{ type: "text", text: "Hi there!" }] });
    expect(data.request.result.stopReason).toBe("end_turn");
    expect(data.request.result.inputTokens).toBe(10);
    expect(data.request.result.outputTokens).toBe(5);
    expect(data.request.result.deliveryStatus).toBe("delivered");
    expect(data.request.result.createdAt).toBe(resCreated.toISOString());
  });

  it("returns request with null result when no result exists", async () => {
    const reqCreated = new Date("2025-06-15T10:00:00Z");
    const reqUpdated = new Date("2025-06-15T10:01:00Z");

    mockSqlResult = [
      {
        id: "req_02",
        provider: "openai",
        model: "gpt-4o",
        params: { messages: [] },
        status: "queued",
        batch_id: null,
        callback_url: null,
        retry_count: 0,
        max_retries: 5,
        request_created_at: reqCreated,
        request_updated_at: reqUpdated,
        result_id: null,
        response: null,
        stop_reason: null,
        input_tokens: null,
        output_tokens: null,
        delivery_status: null,
        result_created_at: null,
      },
    ];

    const event = makeSingleEvent("req_02");
    const response = await getRequestById(event as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.request).toBeDefined();
    expect(data.request.id).toBe("req_02");
    expect(data.request.provider).toBe("openai");
    expect(data.request.model).toBe("gpt-4o");
    expect(data.request.status).toBe("queued");
    expect(data.request.batchId).toBeNull();
    expect(data.request.callbackUrl).toBeNull();

    // Result should be null when no result exists
    expect(data.request.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/requests/:id/redeliver
// ---------------------------------------------------------------------------

function makeRedeliverEvent(id: string, authHeader = "Bearer valid_token") {
  const url = new URL(`http://localhost/api/v1/requests/${id}/redeliver`);

  return {
    request: new Request(url.toString(), {
      method: "POST",
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    url,
    locals: {},
    params: { id },
    cookies: {} as never,
    getClientAddress: () => "127.0.0.1",
    isDataRequest: false,
    isSubRequest: false,
    platform: undefined,
    route: { id: "/api/v1/requests/[id]/redeliver" },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

describe("POST /api/v1/requests/:id/redeliver", () => {
  it("rejects unauthenticated requests (no token)", async () => {
    const event = makeRedeliverEvent("req_01", "");
    const response = await redeliverPost(event as never);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("rejects requests with invalid Bearer token", async () => {
    const event = makeRedeliverEvent("req_01", "Bearer invalid_token");
    const response = await redeliverPost(event as never);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("returns 404 for non-existent request", async () => {
    mockSqlResult = [];
    const event = makeRedeliverEvent("req_nonexistent");
    const response = await redeliverPost(event as never);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("not_found");
  });

  it("returns 409 when request has no result yet", async () => {
    mockSqlResult = [
      {
        request_id: "req_01",
        callback_url: "https://example.com/hook",
        result_id: null,
        delivery_status: null,
      },
    ];
    const event = makeRedeliverEvent("req_01");
    const response = await redeliverPost(event as never);
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error.code).toBe("no_result");
  });

  it("returns 409 when request has no callback URL", async () => {
    mockSqlResult = [
      {
        request_id: "req_01",
        callback_url: null,
        result_id: "res_01",
        delivery_status: "delivered",
      },
    ];
    const event = makeRedeliverEvent("req_01");
    const response = await redeliverPost(event as never);
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error.code).toBe("no_callback_url");
  });

  it("successfully schedules re-delivery and returns 200", async () => {
    mockSqlResult = [
      {
        request_id: "req_01",
        callback_url: "https://example.com/hook",
        result_id: "res_01",
        delivery_status: "delivered",
      },
    ];
    const event = makeRedeliverEvent("req_01");
    const response = await redeliverPost(event as never);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Re-delivery scheduled");
    expect(data.requestId).toBe("req_01");
    expect(data.resultId).toBe("res_01");
    expect(data.previousDeliveryStatus).toBe("delivered");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/requests/:id/retry
// ---------------------------------------------------------------------------

function makeRetryEvent(id: string, authHeader = "Bearer valid_token") {
  const url = new URL(`http://localhost/api/v1/requests/${id}/retry`);

  return {
    request: new Request(url.toString(), {
      method: "POST",
      headers: authHeader ? { authorization: authHeader } : {},
    }),
    url,
    locals: {},
    params: { id },
    cookies: {} as never,
    getClientAddress: () => "127.0.0.1",
    isDataRequest: false,
    isSubRequest: false,
    platform: undefined,
    route: { id: "/api/v1/requests/[id]/retry" },
    fetch: globalThis.fetch,
    setHeaders: vi.fn(),
  };
}

describe("POST /api/v1/requests/:id/retry", () => {
  it("rejects unauthenticated requests (no token)", async () => {
    const event = makeRetryEvent("req_01", "");
    const response = await retryPost(event as never);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("returns 404 for non-existent request", async () => {
    mockSqlResult = [];
    const event = makeRetryEvent("req_nonexistent");
    const response = await retryPost(event as never);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("not_found");
  });

  it("returns 200 with status queued when retrying from failed_final", async () => {
    mockSqlResult = [
      {
        id: "req_01",
        status: "failed_final",
        retry_count: 3,
        batch_id: "batch_01",
        provider: "claude",
        model: "claude-sonnet-4-20250514",
      },
    ];
    const event = makeRetryEvent("req_01");
    const response = await retryPost(event as never);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Request re-queued for processing");
    expect(data.request.id).toBe("req_01");
    expect(data.request.provider).toBe("claude");
    expect(data.request.model).toBe("claude-sonnet-4-20250514");
    expect(data.request.previousStatus).toBe("failed_final");
    expect(data.request.status).toBe("queued");
    expect(data.request.retryCount).toBe(0);
  });

  it("returns 200 with status queued when retrying from canceled", async () => {
    mockSqlResult = [
      {
        id: "req_02",
        status: "canceled",
        retry_count: 1,
        batch_id: "batch_02",
        provider: "openai",
        model: "gpt-4o",
      },
    ];
    const event = makeRetryEvent("req_02");
    const response = await retryPost(event as never);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Request re-queued for processing");
    expect(data.request.id).toBe("req_02");
    expect(data.request.provider).toBe("openai");
    expect(data.request.model).toBe("gpt-4o");
    expect(data.request.previousStatus).toBe("canceled");
    expect(data.request.status).toBe("queued");
    expect(data.request.retryCount).toBe(0);
  });

  it("returns 400 when retrying from non-terminal status queued", async () => {
    mockSqlResult = [
      {
        id: "req_03",
        status: "queued",
        retry_count: 0,
        batch_id: null,
        provider: "claude",
        model: "claude-sonnet-4-20250514",
      },
    ];
    const event = makeRetryEvent("req_03");
    const response = await retryPost(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("invalid_state");
    expect(data.error.message).toContain("queued");
  });

  it("returns 400 when retrying from non-terminal status processing", async () => {
    mockSqlResult = [
      {
        id: "req_04",
        status: "processing",
        retry_count: 0,
        batch_id: "batch_03",
        provider: "openai",
        model: "gpt-4o",
      },
    ];
    const event = makeRetryEvent("req_04");
    const response = await retryPost(event as never);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("invalid_state");
    expect(data.error.message).toContain("processing");
  });
});
