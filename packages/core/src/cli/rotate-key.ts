/**
 * Master key rotation CLI.
 *
 * Re-encrypts all `user_api_keys.api_key_encrypted` records from an old
 * master key to a new master key inside a single database transaction.
 *
 * Each key may be either a 64-character hex string or a passphrase.
 *
 * Usage (development):
 *   npx tsx packages/core/src/cli/rotate-key.ts --old-key <key> --new-key <key>
 *   npx tsx packages/core/src/cli/rotate-key.ts --old-key <key> --new-key <key> --dry-run
 *
 * Requires DATABASE_URL environment variable.
 */

import { basename } from "node:path";
import type postgres from "postgres";
import { deriveKey, encrypt, decrypt } from "../crypto/vault.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RotateKeyOptions {
  oldKey: string;
  newKey: string;
  dryRun: boolean;
}

export interface RotateKeyResult {
  /** Number of keys that were (or would be) re-encrypted. */
  reEncrypted: number;
  /** Whether this was a dry run (no writes). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Core rotation logic (testable, framework-free)
// ---------------------------------------------------------------------------

/**
 * Re-encrypt all API keys from `oldKey` to `newKey`.
 *
 * In dry-run mode, decrypts every key to verify the old key is correct
 * but does not write anything.
 *
 * The entire operation runs inside a transaction: if any decryption or update
 * fails, the transaction is rolled back and an error is thrown.
 *
 * Rows are processed in batches of 500 (ordered by id) to avoid loading the
 * entire table into memory.
 */
export async function rotateKeys(
  sql: postgres.Sql,
  opts: RotateKeyOptions,
): Promise<RotateKeyResult> {
  if (opts.oldKey === opts.newKey) {
    throw new Error("Old key and new key must be different");
  }

  const oldDerivedKey = await deriveKey(opts.oldKey);
  const newDerivedKey = await deriveKey(opts.newKey);

  return await sql.begin(async (tx) => {
    const batchSize = 500;
    let lastId: string | null = null;
    let reEncrypted = 0;

    while (true) {
      const rows =
        lastId === null
          ? await tx<{ id: string; api_key_encrypted: Buffer }[]>`
              SELECT id, api_key_encrypted
              FROM user_api_keys
              ORDER BY id ASC
              LIMIT ${batchSize}
            `
          : await tx<{ id: string; api_key_encrypted: Buffer }[]>`
              SELECT id, api_key_encrypted
              FROM user_api_keys
              WHERE id > ${lastId}
              ORDER BY id ASC
              LIMIT ${batchSize}
            `;

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        // Decrypt with the old key (validates it).
        let plaintext: string;
        try {
          plaintext = decrypt(Buffer.from(row.api_key_encrypted), oldDerivedKey);
        } catch {
          throw new Error(
            `Failed to decrypt key id=${row.id} with the provided old key. ` +
              "Aborting rotation — no keys were modified.",
          );
        }

        if (!opts.dryRun) {
          // Re-encrypt with the new key and update the row.
          const { blob } = encrypt(plaintext, newDerivedKey);
          await tx`
            UPDATE user_api_keys
            SET api_key_encrypted = ${blob},
                updated_at = now()
            WHERE id = ${row.id}
          `;
        }

        reEncrypted++;
      }

      lastId = rows[rows.length - 1]!.id;
    }

    return { reEncrypted, dryRun: opts.dryRun };
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  oldKey: string;
  newKey: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let oldKey: string | undefined;
  let newKey: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--old-key") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for argument: --old-key <key>");
      }
      oldKey = argv[++i];
    } else if (arg === "--new-key") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for argument: --new-key <key>");
      }
      newKey = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!oldKey) {
    throw new Error("Missing required argument: --old-key <key>");
  }
  if (!newKey) {
    throw new Error("Missing required argument: --new-key <key>");
  }

  return { oldKey, newKey, dryRun };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `Usage: rotate-key --old-key <key> --new-key <key> [--dry-run]\n`,
    );
    console.error((err as Error).message);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  // Dynamic import so the module can be tested without postgres being
  // connected at import time.
  const pg = await import("postgres");
  const sql = pg.default(databaseUrl);

  try {
    const modeLabel = args.dryRun ? "[DRY RUN] " : "";
    console.log(`${modeLabel}Starting master key rotation...`);

    const result = await rotateKeys(sql, {
      oldKey: args.oldKey,
      newKey: args.newKey,
      dryRun: args.dryRun,
    });

    if (result.dryRun) {
      console.log(
        `[DRY RUN] All ${result.reEncrypted} key(s) decrypted successfully with the old key. No changes written.`,
      );
    } else {
      console.log(
        `Successfully re-encrypted ${result.reEncrypted} key(s) with the new master key.`,
      );
    }
  } catch (err) {
    console.error("Key rotation failed:", (err as Error).message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

// Run when executed directly (not imported as a module).
// Uses path.basename so the check works on both Unix and Windows paths.
const scriptName = process.argv[1] ? basename(process.argv[1]) : "";
const isDirectRun =
  scriptName === "rotate-key.ts" || scriptName === "rotate-key.js";

if (isDirectRun) {
  main();
}
