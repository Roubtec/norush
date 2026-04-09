import { describe, expect, it } from "vitest";
import {
  selectKeys,
  isFailoverEligibleError,
  type ApiKeyInfo,
} from "../../keys/selector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(overrides: Partial<ApiKeyInfo> = {}): ApiKeyInfo {
  return {
    id: "key_01",
    provider: "claude",
    label: "primary",
    priority: 0,
    failoverEnabled: true,
    revokedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// selectKeys
// ---------------------------------------------------------------------------

describe("selectKeys", () => {
  it("returns keys sorted by priority ascending", () => {
    const keys = [
      makeKey({ id: "key_c", label: "low", priority: 10 }),
      makeKey({ id: "key_a", label: "high", priority: 0 }),
      makeKey({ id: "key_b", label: "mid", priority: 5 }),
    ];

    const candidates = selectKeys(keys);

    expect(candidates.map((c) => c.id)).toEqual(["key_a", "key_b", "key_c"]);
  });

  it("returns an empty list when all keys are revoked", () => {
    const keys = [
      makeKey({ id: "key_01", revokedAt: new Date() }),
      makeKey({ id: "key_02", revokedAt: new Date() }),
    ];

    expect(selectKeys(keys)).toEqual([]);
  });

  it("returns an empty list when no keys provided", () => {
    expect(selectKeys([])).toEqual([]);
  });

  it("excludes revoked keys", () => {
    const keys = [
      makeKey({ id: "key_01", priority: 0 }),
      makeKey({ id: "key_02", priority: 1, revokedAt: new Date() }),
      makeKey({ id: "key_03", priority: 2 }),
    ];

    const candidates = selectKeys(keys);

    expect(candidates.map((c) => c.id)).toEqual(["key_01", "key_03"]);
  });

  it("primary key is always included even if failoverEnabled is false", () => {
    const keys = [
      makeKey({ id: "key_01", priority: 0, failoverEnabled: false }),
      makeKey({ id: "key_02", priority: 1, failoverEnabled: true }),
    ];

    const candidates = selectKeys(keys);

    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe("key_01");
    expect(candidates[1].id).toBe("key_02");
  });

  it("excludes non-primary keys with failoverEnabled=false", () => {
    const keys = [
      makeKey({ id: "key_01", priority: 0, failoverEnabled: true }),
      makeKey({ id: "key_02", priority: 1, failoverEnabled: false }),
      makeKey({ id: "key_03", priority: 2, failoverEnabled: true }),
    ];

    const candidates = selectKeys(keys);

    expect(candidates.map((c) => c.id)).toEqual(["key_01", "key_03"]);
  });

  it("handles a single key", () => {
    const keys = [makeKey({ id: "key_only", priority: 0 })];

    const candidates = selectKeys(keys);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("key_only");
  });

  it("returns candidate objects with correct fields", () => {
    const keys = [makeKey({ id: "key_01", label: "Production", priority: 5 })];

    const [candidate] = selectKeys(keys);

    expect(candidate).toEqual({
      id: "key_01",
      label: "Production",
      priority: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// isFailoverEligibleError
// ---------------------------------------------------------------------------

describe("isFailoverEligibleError", () => {
  it("returns true for 429 rate limit errors", () => {
    expect(isFailoverEligibleError(new Error("HTTP 429: rate limit exceeded"))).toBe(true);
  });

  it("returns true for rate limit in message", () => {
    expect(isFailoverEligibleError(new Error("Rate limit reached"))).toBe(true);
  });

  it("returns true for quota exhaustion", () => {
    expect(isFailoverEligibleError(new Error("Quota exceeded for this API key"))).toBe(true);
  });

  it("returns true for credit exhaustion", () => {
    expect(isFailoverEligibleError(new Error("Insufficient credit balance"))).toBe(true);
  });

  it("returns true for billing errors", () => {
    expect(isFailoverEligibleError(new Error("Billing limit exceeded"))).toBe(true);
  });

  it("returns true for error objects with status 429", () => {
    const error = Object.assign(new Error("Too many requests"), { status: 429 });
    expect(isFailoverEligibleError(error)).toBe(true);
  });

  it("returns true for error objects with statusCode 429", () => {
    const error = Object.assign(new Error("Throttled"), { statusCode: 429 });
    expect(isFailoverEligibleError(error)).toBe(true);
  });

  it("returns false for network errors", () => {
    expect(isFailoverEligibleError(new Error("ECONNREFUSED"))).toBe(false);
  });

  it("returns false for 500 server errors", () => {
    expect(isFailoverEligibleError(new Error("Internal server error"))).toBe(false);
  });

  it("returns false for malformed request errors", () => {
    expect(isFailoverEligibleError(new Error("Invalid request format"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isFailoverEligibleError("some string")).toBe(false);
    expect(isFailoverEligibleError(null)).toBe(false);
    expect(isFailoverEligibleError(undefined)).toBe(false);
    expect(isFailoverEligibleError(42)).toBe(false);
  });
});
