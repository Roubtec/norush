/**
 * Tests for API key CRUD operations, validation, and masking.
 *
 * Mocks the postgres.js connection and the crypto vault to test the
 * api-keys module in isolation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @norush/core crypto functions
// ---------------------------------------------------------------------------

const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();
const mockDeriveKey = vi.fn();
const mockMaskApiKey = vi.fn();

vi.mock("@norush/core", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  deriveKey: (...args: unknown[]) => mockDeriveKey(...args),
  maskApiKey: (...args: unknown[]) => mockMaskApiKey(...args),
}));

// Mock ulidx
vi.mock("ulidx", () => ({
  ulid: () => "01TESTULID000000000000000",
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const FAKE_KEY = Buffer.alloc(32, 0xab);
const FAKE_BLOB = Buffer.from("encrypted-blob");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NORUSH_MASTER_KEY", "a".repeat(64));

  mockEncrypt.mockReset();
  mockDecrypt.mockReset();
  mockDeriveKey.mockReset();
  mockMaskApiKey.mockReset();

  mockDeriveKey.mockResolvedValue(FAKE_KEY);
  mockEncrypt.mockReturnValue({ blob: FAKE_BLOB });
  mockDecrypt.mockReturnValue("sk-ant-api03-decrypted");
  mockMaskApiKey.mockReturnValue("sk-ant...****");
});

async function getModule() {
  // Reset cached master key between tests
  const mod = await import("$lib/server/api-keys");
  mod.resetMasterKey();
  return mod;
}

// ---------------------------------------------------------------------------
// Mock SQL helper
// ---------------------------------------------------------------------------

function createMockSql(rows: Record<string, unknown>[] = []) {
  const result = Object.assign(rows, { count: rows.length });
  const fn = vi.fn().mockResolvedValue(result);

  // Tagged template literal support — postgres.js uses sql`...` syntax
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    return fn(strings, ..._values);
  };

  return sql as unknown as import("postgres").Sql;
}

// ---------------------------------------------------------------------------
// validateApiKeyInput
// ---------------------------------------------------------------------------

describe("validateApiKeyInput", () => {
  it("returns no errors for valid input", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "claude",
      label: "Primary",
      apiKey: "sk-ant-api03-abc123def456",
    });
    expect(errors).toEqual([]);
  });

  it("rejects empty provider", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "",
      label: "Test",
      apiKey: "sk-ant-api03-abc123def456",
    });
    expect(errors.some((e) => e.field === "provider")).toBe(true);
  });

  it("rejects invalid provider", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "google",
      label: "Test",
      apiKey: "sk-ant-api03-abc123def456",
    });
    expect(errors.some((e) => e.field === "provider")).toBe(true);
  });

  it("rejects empty label", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "claude",
      label: "",
      apiKey: "sk-ant-api03-abc123def456",
    });
    expect(errors.some((e) => e.field === "label")).toBe(true);
  });

  it("rejects label that is only whitespace", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "claude",
      label: "   ",
      apiKey: "sk-ant-api03-abc123def456",
    });
    expect(errors.some((e) => e.field === "label")).toBe(true);
  });

  it("rejects label longer than 100 chars", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "claude",
      label: "x".repeat(101),
      apiKey: "sk-ant-api03-abc123def456",
    });
    expect(errors.some((e) => e.field === "label")).toBe(true);
  });

  it("rejects empty API key", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "claude",
      label: "Primary",
      apiKey: "",
    });
    expect(errors.some((e) => e.field === "apiKey")).toBe(true);
  });

  it("rejects API key that is too short", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "claude",
      label: "Primary",
      apiKey: "sk-short",
    });
    expect(errors.some((e) => e.field === "apiKey")).toBe(true);
  });

  it("rejects Claude key with wrong prefix", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "claude",
      label: "Primary",
      apiKey: "sk-proj-abc123def456",
    });
    expect(errors.some((e) => e.field === "apiKey")).toBe(true);
  });

  it("accepts OpenAI key with correct prefix", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "openai",
      label: "Primary",
      apiKey: "sk-proj-abc123def456",
    });
    expect(errors).toEqual([]);
  });

  it("can return multiple errors at once", async () => {
    const { validateApiKeyInput } = await getModule();
    const errors = validateApiKeyInput({
      provider: "",
      label: "",
      apiKey: "",
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// listApiKeys
// ---------------------------------------------------------------------------

describe("listApiKeys", () => {
  it("returns masked keys from database rows", async () => {
    const { listApiKeys } = await getModule();

    const sql = createMockSql([
      {
        id: "key1",
        provider: "claude",
        label: "Primary",
        api_key_encrypted: Buffer.from("encrypted"),
        priority: 0,
        failover_enabled: true,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ]);

    const keys = await listApiKeys(sql, "user_01ABC");

    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe("key1");
    expect(keys[0].provider).toBe("claude");
    expect(keys[0].label).toBe("Primary");
    expect(keys[0].maskedKey).toBe("sk-ant...****");
    expect(keys[0].priority).toBe(0);
    expect(keys[0].failoverEnabled).toBe(true);
  });

  it("returns empty array when no keys exist", async () => {
    const { listApiKeys } = await getModule();
    const sql = createMockSql([]);
    const keys = await listApiKeys(sql, "user_01ABC");
    expect(keys).toEqual([]);
  });

  it("handles decryption failure gracefully", async () => {
    const { listApiKeys } = await getModule();
    mockDecrypt.mockImplementation(() => {
      throw new Error("Decryption failed");
    });

    const sql = createMockSql([
      {
        id: "key1",
        provider: "claude",
        label: "Broken",
        api_key_encrypted: Buffer.from("corrupted"),
        priority: 0,
        failover_enabled: true,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ]);

    const keys = await listApiKeys(sql, "user_01ABC");
    expect(keys).toHaveLength(1);
    expect(keys[0].maskedKey).toBe("[decryption error]");
  });
});

// ---------------------------------------------------------------------------
// createApiKey
// ---------------------------------------------------------------------------

describe("createApiKey", () => {
  it("encrypts the key and returns a masked record", async () => {
    const { createApiKey } = await getModule();
    const sql = createMockSql();

    const result = await createApiKey(sql, {
      userId: "user_01ABC",
      provider: "claude",
      label: "Primary",
      apiKey: "sk-ant-api03-secretkey",
    });

    expect(result.id).toBe("01TESTULID000000000000000");
    expect(result.provider).toBe("claude");
    expect(result.label).toBe("Primary");
    expect(result.maskedKey).toBe("sk-ant...****");
    expect(result.priority).toBe(0);
    expect(result.failoverEnabled).toBe(true);

    // Verify encrypt was called with the plaintext key
    expect(mockEncrypt).toHaveBeenCalledWith("sk-ant-api03-secretkey", FAKE_KEY);
  });

  it("uses provided priority and failover values", async () => {
    const { createApiKey } = await getModule();
    const sql = createMockSql();

    const result = await createApiKey(sql, {
      userId: "user_01ABC",
      provider: "openai",
      label: "Backup",
      apiKey: "sk-proj-abc123def456",
      priority: 5,
      failoverEnabled: false,
    });

    expect(result.priority).toBe(5);
    expect(result.failoverEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteApiKey
// ---------------------------------------------------------------------------

describe("deleteApiKey", () => {
  it("returns true when a key is deleted", async () => {
    const { deleteApiKey } = await getModule();
    const rows = Object.assign([], { count: 1 });
    const fn = vi.fn().mockResolvedValue(rows);
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) =>
      fn(strings, ..._values)) as unknown as import("postgres").Sql;

    const result = await deleteApiKey(sql, "user_01ABC", "key_01XYZ");
    expect(result).toBe(true);
  });

  it("returns false when key is not found", async () => {
    const { deleteApiKey } = await getModule();
    const rows = Object.assign([], { count: 0 });
    const fn = vi.fn().mockResolvedValue(rows);
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) =>
      fn(strings, ..._values)) as unknown as import("postgres").Sql;

    const result = await deleteApiKey(sql, "user_01ABC", "nonexistent");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decryptApiKey
// ---------------------------------------------------------------------------

describe("decryptApiKey", () => {
  it("returns the plaintext key for a valid record", async () => {
    const { decryptApiKey } = await getModule();

    const sql = createMockSql([
      { api_key_encrypted: Buffer.from("encrypted-data") },
    ]);

    const plaintext = await decryptApiKey(sql, "key_01ABC");
    expect(plaintext).toBe("sk-ant-api03-decrypted");
    expect(mockDecrypt).toHaveBeenCalled();
  });

  it("throws when key is not found", async () => {
    const { decryptApiKey } = await getModule();
    const sql = createMockSql([]);

    await expect(decryptApiKey(sql, "nonexistent")).rejects.toThrow(
      "API key not found",
    );
  });
});

// ---------------------------------------------------------------------------
// Master key required
// ---------------------------------------------------------------------------

describe("master key requirement", () => {
  it("throws when NORUSH_MASTER_KEY is not set", async () => {
    vi.stubEnv("NORUSH_MASTER_KEY", "");
    const { listApiKeys, resetMasterKey } = await getModule();
    resetMasterKey();

    const sql = createMockSql([
      {
        id: "key1",
        provider: "claude",
        label: "Test",
        api_key_encrypted: Buffer.from("data"),
        priority: 0,
        failover_enabled: true,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ]);

    await expect(listApiKeys(sql, "user_01ABC")).rejects.toThrow(
      "NORUSH_MASTER_KEY",
    );
  });
});
