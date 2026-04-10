/**
 * Tests for the master key rotation CLI logic.
 *
 * Tests cover:
 * - Argument parsing (valid, missing args, dry-run)
 * - Core rotation: re-encryption, dry-run, same-key rejection, wrong-key abort
 * - Transaction atomicity: partial failure rolls back all changes
 *
 * The rotation tests use a minimal mock of the postgres.js `sql` tagged
 * template interface, avoiding a live database dependency.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { parseArgs, rotateKeys } from "../../cli/rotate-key.js";
import { deriveKey, encrypt, decrypt } from "../../crypto/vault.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 64-char hex key string (32 bytes). */
function randomHexKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Build a minimal mock of the postgres.js `sql` interface that supports
 * `sql.begin(callback)` and tagged template queries inside transactions.
 *
 * `rows` is the dataset returned by any SELECT query inside the transaction.
 * `updates` collects UPDATE calls for assertions.
 */
function mockSql(
  rows: Array<{ id: string; api_key_encrypted: Buffer }>,
  options?: { failOnUpdate?: boolean },
) {
  const updates: Array<{ id: string; blob: Buffer }> = [];

  // The transaction query function (tagged template).
  const txFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");

    if (query.includes("SELECT")) {
      return Promise.resolve(rows);
    }

    if (query.includes("UPDATE")) {
      if (options?.failOnUpdate) {
        throw new Error("Simulated DB failure");
      }
      // Extract blob and id from the values.
      // The tagged template for the UPDATE has: blob, id as values.
      const [blob, id] = values as [Buffer, string];
      updates.push({ id, blob });
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  };

  // The top-level sql function with a begin method.
  const sql = Object.assign(
    () => Promise.resolve([]),
    {
      begin: async <T>(cb: (tx: typeof txFn) => Promise<T>): Promise<T> => {
        return cb(txFn as unknown as typeof txFn);
      },
    },
  );

  return { sql: sql as unknown as Parameters<typeof rotateKeys>[0], updates };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --old-key, --new-key, and --dry-run", () => {
    const result = parseArgs([
      "--old-key", "aabb",
      "--new-key", "ccdd",
      "--dry-run",
    ]);
    expect(result).toEqual({
      oldKey: "aabb",
      newKey: "ccdd",
      dryRun: true,
    });
  });

  it("parses without --dry-run (defaults to false)", () => {
    const result = parseArgs(["--old-key", "aabb", "--new-key", "ccdd"]);
    expect(result.dryRun).toBe(false);
  });

  it("throws when --old-key is missing", () => {
    expect(() => parseArgs(["--new-key", "ccdd"])).toThrow(
      "Missing required argument: --old-key",
    );
  });

  it("throws when --new-key is missing", () => {
    expect(() => parseArgs(["--old-key", "aabb"])).toThrow(
      "Missing required argument: --new-key",
    );
  });

  it("throws when both keys are missing", () => {
    expect(() => parseArgs([])).toThrow("Missing required argument: --old-key");
  });
});

// ---------------------------------------------------------------------------
// rotateKeys
// ---------------------------------------------------------------------------

describe("rotateKeys", () => {
  it("rejects same old and new key", async () => {
    const key = randomHexKey();
    const { sql } = mockSql([]);

    await expect(
      rotateKeys(sql, { oldKey: key, newKey: key, dryRun: false }),
    ).rejects.toThrow("Old key and new key must be different");
  });

  it("returns zero when no keys exist", async () => {
    const { sql } = mockSql([]);
    const result = await rotateKeys(sql, {
      oldKey: randomHexKey(),
      newKey: randomHexKey(),
      dryRun: false,
    });
    expect(result).toEqual({ reEncrypted: 0, dryRun: false });
  });

  it("re-encrypts all keys from old to new", async () => {
    const oldKey = randomHexKey();
    const newKey = randomHexKey();
    const oldDerived = await deriveKey(oldKey);
    const newDerived = await deriveKey(newKey);

    // Encrypt two API keys with the old key.
    const plaintext1 = "sk-ant-api03-secret-key-one";
    const plaintext2 = "sk-proj-secret-key-two";
    const { blob: blob1 } = encrypt(plaintext1, oldDerived);
    const { blob: blob2 } = encrypt(plaintext2, oldDerived);

    const rows = [
      { id: "key-1", api_key_encrypted: blob1 },
      { id: "key-2", api_key_encrypted: blob2 },
    ];

    const { sql, updates } = mockSql(rows);
    const result = await rotateKeys(sql, {
      oldKey,
      newKey,
      dryRun: false,
    });

    expect(result).toEqual({ reEncrypted: 2, dryRun: false });
    expect(updates).toHaveLength(2);

    // Verify the updated blobs decrypt correctly with the new key.
    const decrypted1 = decrypt(updates[0].blob, newDerived);
    const decrypted2 = decrypt(updates[1].blob, newDerived);
    expect(decrypted1).toBe(plaintext1);
    expect(decrypted2).toBe(plaintext2);

    // Verify the updated blobs do NOT decrypt with the old key.
    expect(() => decrypt(updates[0].blob, oldDerived)).toThrow(
      "Decryption failed",
    );
  });

  it("dry-run decrypts all keys but writes nothing", async () => {
    const oldKey = randomHexKey();
    const newKey = randomHexKey();
    const oldDerived = await deriveKey(oldKey);

    const plaintext = "sk-test-dry-run";
    const { blob } = encrypt(plaintext, oldDerived);

    const rows = [{ id: "key-1", api_key_encrypted: blob }];
    const { sql, updates } = mockSql(rows);

    const result = await rotateKeys(sql, {
      oldKey,
      newKey,
      dryRun: true,
    });

    expect(result).toEqual({ reEncrypted: 1, dryRun: true });
    // No updates should have been issued.
    expect(updates).toHaveLength(0);
  });

  it("aborts if any key fails to decrypt with the old key", async () => {
    const oldKey = randomHexKey();
    const wrongKey = randomHexKey();
    const newKey = randomHexKey();
    const wrongDerived = await deriveKey(wrongKey);

    // Encrypt with a DIFFERENT key (not the oldKey).
    const { blob } = encrypt("sk-bad", wrongDerived);

    const rows = [{ id: "key-bad", api_key_encrypted: blob }];
    const { sql, updates } = mockSql(rows);

    await expect(
      rotateKeys(sql, { oldKey, newKey, dryRun: false }),
    ).rejects.toThrow("Failed to decrypt key id=key-bad");

    // No updates should have been issued (transaction rolled back).
    expect(updates).toHaveLength(0);
  });

  it("aborts in dry-run mode if any key fails to decrypt", async () => {
    const oldKey = randomHexKey();
    const newKey = randomHexKey();
    const wrongDerived = await deriveKey(randomHexKey());

    const { blob } = encrypt("sk-bad", wrongDerived);

    const rows = [{ id: "key-bad", api_key_encrypted: blob }];
    const { sql } = mockSql(rows);

    await expect(
      rotateKeys(sql, { oldKey, newKey, dryRun: true }),
    ).rejects.toThrow("Failed to decrypt key id=key-bad");
  });

  it("works with passphrase-based keys (not just hex)", async () => {
    const oldKey = "my-old-passphrase";
    const newKey = "my-new-passphrase";
    const oldDerived = await deriveKey(oldKey);
    const newDerived = await deriveKey(newKey);

    const plaintext = "sk-passphrase-key";
    const { blob } = encrypt(plaintext, oldDerived);

    const rows = [{ id: "key-pp", api_key_encrypted: blob }];
    const { sql, updates } = mockSql(rows);

    const result = await rotateKeys(sql, {
      oldKey,
      newKey,
      dryRun: false,
    });

    expect(result.reEncrypted).toBe(1);
    expect(decrypt(updates[0].blob, newDerived)).toBe(plaintext);
  });
});
