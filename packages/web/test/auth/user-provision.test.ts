/**
 * Tests for user provisioning (creation idempotency).
 *
 * Uses a mock postgres.js connection to verify SQL behavior without a real database.
 */

import { describe, it, expect, vi } from "vitest";
import { provisionUser, findUser } from "$lib/server/user";

// ---------------------------------------------------------------------------
// Helpers: mock postgres.Sql
// ---------------------------------------------------------------------------

type UserRow = { id: string; created_at: string; updated_at: string };

interface MockSql {
  (...args: unknown[]): Promise<UserRow[]>;
  begin: ReturnType<typeof vi.fn>;
}

function createMockSql(existingUsers: Map<string, UserRow>): MockSql {
  // The tagged template function for simple queries
  const sqlFn = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const queryStr = _strings.join("?");

    if (queryStr.includes("SELECT") && queryStr.includes("FROM users")) {
      const id = _values[0] as string;
      const user = existingUsers.get(id);
      return user ? [user] : [];
    }

    return [];
  });

  const sql = sqlFn as unknown as MockSql;

  // Transaction support
  sql.begin = vi.fn(async (callback: (tx: unknown) => Promise<void>) => {
    const tx = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const queryStr = _strings.join("?");

      // Simulate INSERT INTO users
      if (queryStr.includes("INSERT INTO users")) {
        const id = _values[0] as string;
        if (!existingUsers.has(id)) {
          const now = new Date().toISOString();
          existingUsers.set(id, { id, created_at: now, updated_at: now });
        }
      }

      return [];
    });

    await callback(tx);
  });

  return sql;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provisionUser", () => {
  it("creates a new user when none exists", async () => {
    const users = new Map<string, { id: string; created_at: string; updated_at: string }>();
    const sql = createMockSql(users);

    const result = await provisionUser(sql as never, {
      workosId: "user_01NEW",
      email: "new@example.com",
      firstName: "New",
      lastName: "User",
    });

    expect(result.id).toBe("user_01NEW");
    expect(users.has("user_01NEW")).toBe(true);
  });

  it("is idempotent: does not create duplicate for existing user", async () => {
    const now = new Date().toISOString();
    const users = new Map([
      ["user_01EXIST", { id: "user_01EXIST", created_at: now, updated_at: now }],
    ]);
    const sql = createMockSql(users);

    const result = await provisionUser(sql as never, {
      workosId: "user_01EXIST",
      email: "existing@example.com",
      firstName: "Existing",
      lastName: "User",
    });

    expect(result.id).toBe("user_01EXIST");
    // Map should still have exactly one entry
    expect(users.size).toBe(1);
  });

  it("second provision call returns the same user", async () => {
    const users = new Map<string, { id: string; created_at: string; updated_at: string }>();
    const sql = createMockSql(users);

    const sessionUser = {
      workosId: "user_01TWICE",
      email: "twice@example.com",
      firstName: "Twice",
      lastName: "User",
    };

    const first = await provisionUser(sql as never, sessionUser);
    const second = await provisionUser(sql as never, sessionUser);

    expect(first.id).toBe(second.id);
    expect(users.size).toBe(1);
  });
});

describe("findUser", () => {
  it("returns null for non-existent user", async () => {
    const users = new Map<string, { id: string; created_at: string; updated_at: string }>();
    const sql = createMockSql(users);

    const result = await findUser(sql as never, "user_NOPE");
    expect(result).toBeNull();
  });

  it("returns user record for existing user", async () => {
    const now = new Date().toISOString();
    const users = new Map([
      ["user_01FOUND", { id: "user_01FOUND", created_at: now, updated_at: now }],
    ]);
    const sql = createMockSql(users);

    const result = await findUser(sql as never, "user_01FOUND");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("user_01FOUND");
    expect(result?.createdAt).toBeInstanceOf(Date);
  });
});
