/**
 * Test database setup/teardown helpers for PostgreSQL integration tests.
 *
 * Creates a fresh test schema per suite within the configured database and
 * drops that schema afterwards.
 */

import postgres from 'postgres';
import { migrate } from '../../store/migrate.js';

const DEFAULT_DATABASE_URL = 'postgres://postgres:dev@localhost:5432/norush';

/**
 * Create a postgres.js connection for testing.
 * Uses DATABASE_URL env var, falling back to the default Docker Compose config.
 */
export function getTestDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/**
 * Returns true if a PostgreSQL connection can be established.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  const url = getTestDatabaseUrl();
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end();
  }
}

/**
 * Create a test schema (using a unique schema per test run) and run migrations.
 * Returns the sql connection and a cleanup function.
 */
export async function setupTestDatabase(): Promise<{
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}> {
  const url = getTestDatabaseUrl();
  const schemaName = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Use a single-connection client so that the SET search_path applied during
  // schema creation persists for all subsequent queries (SET is session-scoped;
  // in a pool the setting only applies to the connection that ran it).
  const sql = postgres(url, {
    max: 1,
    connection: { search_path: schemaName },
  });

  // Create an isolated schema for this test run.
  await sql.unsafe(`CREATE SCHEMA ${schemaName}`);

  // Run migrations within this schema.
  await migrate(sql);

  // Create the prerequisite users and API key for FK constraints.
  // 'test-user' is the default userId used across most contract tests.
  // 'alice' and 'bob' are used by retention contract tests (multi-user scenarios).
  await sql`
    INSERT INTO users (id) VALUES ('test-user'), ('alice'), ('bob')
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO user_api_keys (id, user_id, provider, label, api_key_encrypted)
    VALUES ('test-key', 'test-user', 'claude', 'primary', '\\x00')
    ON CONFLICT DO NOTHING
  `;

  const cleanup = async () => {
    await sql.unsafe(`DROP SCHEMA ${schemaName} CASCADE`);
    await sql.end();
  };

  return { sql, cleanup };
}
