/**
 * Minimal migration runner for norush.
 *
 * Reads numbered `.sql` files from the migrations directory, tracks applied
 * migrations in a `schema_migrations` table, and applies missing ones in
 * order inside a transaction. Idempotent — safe to call on every startup.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

/** Path to the migrations directory (relative to package root). */
const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url);

/**
 * Run all pending migrations against the given postgres.js connection.
 *
 * Creates the `schema_migrations` table if it does not exist, then applies
 * each unapplied `.sql` file in filename order within a transaction.
 *
 * @returns Names of the migration files that were applied (empty if up-to-date).
 */
export async function migrate(
  sql: postgres.Sql,
  migrationsDir?: string,
): Promise<string[]> {
  const dir = migrationsDir ?? fileURLToPath(MIGRATIONS_DIR);

  // Ensure tracking table exists (outside the main transaction so it's
  // visible immediately).
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Read migration files, sorted by filename.
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) return [];

  // Apply all pending migrations inside a single transaction, protected by a
  // transaction-scoped advisory lock so concurrent startups cannot compute and
  // run the same pending set at the same time.
  return await sql.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(922337203685477580::bigint)
    `;

    // Determine applied migrations after acquiring the lock so concurrent
    // runners see a consistent, serialized view.
    const applied = await tx<{ name: string }[]>`
      SELECT name FROM schema_migrations ORDER BY name
    `;
    const appliedSet = new Set(applied.map((r) => r.name));

    const pending = files.filter((f) => !appliedSet.has(f));
    if (pending.length === 0) return [];

    const appliedNow: string[] = [];
    for (const file of pending) {
      const content = await readFile(join(dir, file), "utf-8");
      await tx.unsafe(content);
      await tx`
        INSERT INTO schema_migrations (name) VALUES (${file})
      `;
      appliedNow.push(file);
    }

    return appliedNow;
  });
}
