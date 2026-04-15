/**
 * Tests for the master key rotation CLI logic.
 *
 * Tests cover:
 * - Argument parsing (valid, missing args, unknown args, dry-run)
 * - Core rotation: re-encryption, dry-run, same-key rejection, wrong-key abort
 * - Transaction atomicity: partial UPDATE failure rolls back all changes
 *
 * The rotation tests use a minimal mock of the postgres.js `sql` tagged
 * template interface, avoiding a live database dependency.
 *
 * The mock simulates real transaction rollback semantics: updates buffered
 * inside `begin` are only exposed to the test if the callback resolves
 * without throwing.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { parseArgs, rotateKeys } from '../../cli/rotate-key.js';
import { deriveKey, encrypt, decrypt } from '../../crypto/vault.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 64-char hex key string (32 bytes). */
function randomHexKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Build a minimal mock of the postgres.js `sql` interface that supports
 * `sql.begin(callback)` and tagged template queries inside transactions.
 *
 * `rows` is the dataset returned by SELECT queries inside the transaction.
 * The mock handles the batched pagination pattern: the first SELECT returns
 * `rows`, subsequent SELECTs return `[]` (signalling end of batches).
 *
 * `updates` only exposes updates that were committed (i.e. the callback
 * resolved without throwing), mirroring real transaction rollback semantics.
 * If the callback throws, pending updates are discarded.
 *
 * `failOnNthUpdate` causes the Nth UPDATE to throw a simulated DB error,
 * allowing tests to verify partial-failure rollback.
 */
function mockSql(
  rows: Array<{ id: string; api_key_encrypted: Buffer }>,
  options?: { failOnNthUpdate?: number },
) {
  const committedUpdates: Array<{ id: string; blob: Buffer }> = [];

  const sql = Object.assign(() => Promise.resolve([]), {
    begin: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      const pendingUpdates: Array<{ id: string; blob: Buffer }> = [];
      let updateCount = 0;
      let selectCount = 0;

      const txFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join('?');

        if (query.includes('SELECT')) {
          selectCount++;
          // First SELECT returns all rows; subsequent ones return [] to
          // signal end of the cursor-based batch loop.
          return Promise.resolve(selectCount === 1 ? rows : []);
        }

        if (query.includes('UPDATE')) {
          updateCount++;
          if (options?.failOnNthUpdate !== undefined && updateCount === options.failOnNthUpdate) {
            throw new Error('Simulated DB failure');
          }
          // Values in the UPDATE template: blob, id (in that order).
          const [blob, id] = values as [Buffer, string];
          pendingUpdates.push({ id, blob });
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      };

      const result = await cb(txFn);
      // Transaction committed — expose the buffered updates.
      committedUpdates.push(...pendingUpdates);
      return result;
    },
  });

  return { sql: sql as unknown as Parameters<typeof rotateKeys>[0], updates: committedUpdates };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --old-key, --new-key, and --dry-run', () => {
    const result = parseArgs(['--old-key', 'aabb', '--new-key', 'ccdd', '--dry-run']);
    expect(result).toEqual({
      oldKey: 'aabb',
      newKey: 'ccdd',
      dryRun: true,
    });
  });

  it('parses without --dry-run (defaults to false)', () => {
    const result = parseArgs(['--old-key', 'aabb', '--new-key', 'ccdd']);
    expect(result.dryRun).toBe(false);
  });

  it('throws when --old-key is missing', () => {
    expect(() => parseArgs(['--new-key', 'ccdd'])).toThrow('Missing required argument: --old-key');
  });

  it('throws when --new-key is missing', () => {
    expect(() => parseArgs(['--old-key', 'aabb'])).toThrow('Missing required argument: --new-key');
  });

  it('throws when both keys are missing', () => {
    expect(() => parseArgs([])).toThrow('Missing required argument: --old-key');
  });

  it('throws when --old-key has no following value', () => {
    expect(() => parseArgs(['--old-key'])).toThrow('Missing value for argument: --old-key');
  });

  it('throws when --new-key has no following value', () => {
    expect(() => parseArgs(['--old-key', 'aabb', '--new-key'])).toThrow(
      'Missing value for argument: --new-key',
    );
  });

  it('throws on unknown arguments', () => {
    expect(() => parseArgs(['--old-key', 'aabb', '--new-key', 'ccdd', '--force'])).toThrow(
      'Unknown argument: --force',
    );
  });
});

// ---------------------------------------------------------------------------
// rotateKeys
// ---------------------------------------------------------------------------

describe('rotateKeys', () => {
  it('rejects same old and new key', async () => {
    const key = randomHexKey();
    const { sql } = mockSql([]);

    await expect(rotateKeys(sql, { oldKey: key, newKey: key, dryRun: false })).rejects.toThrow(
      'Old key and new key must be different',
    );
  });

  it('returns zero when no keys exist', async () => {
    const { sql } = mockSql([]);
    const result = await rotateKeys(sql, {
      oldKey: randomHexKey(),
      newKey: randomHexKey(),
      dryRun: false,
    });
    expect(result).toEqual({ reEncrypted: 0, dryRun: false });
  });

  it('re-encrypts all keys from old to new', async () => {
    const oldKey = randomHexKey();
    const newKey = randomHexKey();
    const oldDerived = await deriveKey(oldKey);
    const newDerived = await deriveKey(newKey);

    // Encrypt two API keys with the old key.
    const plaintext1 = 'sk-ant-api03-secret-key-one';
    const plaintext2 = 'sk-proj-secret-key-two';
    const { blob: blob1 } = encrypt(plaintext1, oldDerived);
    const { blob: blob2 } = encrypt(plaintext2, oldDerived);

    const rows = [
      { id: 'key-1', api_key_encrypted: blob1 },
      { id: 'key-2', api_key_encrypted: blob2 },
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
    expect(() => decrypt(updates[0].blob, oldDerived)).toThrow('Decryption failed');
  });

  it('dry-run decrypts all keys but writes nothing', async () => {
    const oldKey = randomHexKey();
    const newKey = randomHexKey();
    const oldDerived = await deriveKey(oldKey);

    const plaintext = 'sk-test-dry-run';
    const { blob } = encrypt(plaintext, oldDerived);

    const rows = [{ id: 'key-1', api_key_encrypted: blob }];
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

  it('aborts if any key fails to decrypt with the old key', async () => {
    const oldKey = randomHexKey();
    const wrongKey = randomHexKey();
    const newKey = randomHexKey();
    const wrongDerived = await deriveKey(wrongKey);

    // Encrypt with a DIFFERENT key (not the oldKey).
    const { blob } = encrypt('sk-bad', wrongDerived);

    const rows = [{ id: 'key-bad', api_key_encrypted: blob }];
    const { sql, updates } = mockSql(rows);

    await expect(rotateKeys(sql, { oldKey, newKey, dryRun: false })).rejects.toThrow(
      'Failed to decrypt key id=key-bad',
    );

    // No updates should have been committed (transaction rolled back).
    expect(updates).toHaveLength(0);
  });

  it('aborts in dry-run mode if any key fails to decrypt', async () => {
    const oldKey = randomHexKey();
    const newKey = randomHexKey();
    const wrongDerived = await deriveKey(randomHexKey());

    const { blob } = encrypt('sk-bad', wrongDerived);

    const rows = [{ id: 'key-bad', api_key_encrypted: blob }];
    const { sql } = mockSql(rows);

    await expect(rotateKeys(sql, { oldKey, newKey, dryRun: true })).rejects.toThrow(
      'Failed to decrypt key id=key-bad',
    );
  });

  it('works with passphrase-based keys (not just hex)', async () => {
    const oldKey = 'my-old-passphrase';
    const newKey = 'my-new-passphrase';
    const oldDerived = await deriveKey(oldKey);
    const newDerived = await deriveKey(newKey);

    const plaintext = 'sk-passphrase-key';
    const { blob } = encrypt(plaintext, oldDerived);

    const rows = [{ id: 'key-pp', api_key_encrypted: blob }];
    const { sql, updates } = mockSql(rows);

    const result = await rotateKeys(sql, {
      oldKey,
      newKey,
      dryRun: false,
    });

    expect(result.reEncrypted).toBe(1);
    expect(decrypt(updates[0].blob, newDerived)).toBe(plaintext);
  });

  it('rolls back all changes if a mid-rotation UPDATE fails', async () => {
    const oldKey = randomHexKey();
    const newKey = randomHexKey();
    const oldDerived = await deriveKey(oldKey);

    const plaintext1 = 'sk-key-one';
    const plaintext2 = 'sk-key-two';
    const { blob: blob1 } = encrypt(plaintext1, oldDerived);
    const { blob: blob2 } = encrypt(plaintext2, oldDerived);

    const rows = [
      { id: 'key-1', api_key_encrypted: blob1 },
      { id: 'key-2', api_key_encrypted: blob2 },
    ];

    // The 2nd UPDATE (key-2) will throw after key-1 has already been updated.
    const { sql, updates } = mockSql(rows, { failOnNthUpdate: 2 });

    await expect(rotateKeys(sql, { oldKey, newKey, dryRun: false })).rejects.toThrow(
      'Simulated DB failure',
    );

    // No updates should be committed — the transaction was rolled back.
    expect(updates).toHaveLength(0);
  });
});
