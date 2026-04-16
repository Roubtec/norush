/**
 * PostgresStore integration tests.
 *
 * Runs the shared Store contract suite against a real PostgreSQL database.
 * The entire suite is skipped when Docker PostgreSQL is not reachable.
 *
 * To run these tests:
 *   docker compose up -d
 *   DATABASE_URL=postgres://postgres:dev@localhost:5432/norush pnpm test
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { PostgresStore } from '../../store/postgres.js';
import { isDatabaseAvailable, setupTestDatabase } from '../helpers/db.js';
import { runStoreContractTests } from './store-contract.test.js';
import type postgres from 'postgres';

// Probe DB availability before test collection. This must be synchronous
// at the module level; we check it asynchronously in beforeAll and track
// state via a mutable reference.
const state: {
  sql?: postgres.Sql;
  cleanup?: () => Promise<void>;
  available: boolean;
} = { available: false };

describe('PostgresStore', () => {
  beforeAll(async () => {
    state.available = await isDatabaseAvailable();
    if (!state.available) return;

    const setup = await setupTestDatabase();
    state.sql = setup.sql;
    state.cleanup = setup.cleanup;
  });

  afterAll(async () => {
    if (state.cleanup) await state.cleanup();
  });

  it('database is available', ({ skip }) => {
    if (!state.available) {
      skip();
      return;
    }
    expect(state.sql).toBeDefined();
  });

  runStoreContractTests(
    async () => {
      if (!state.sql) throw new Error('Database not available');
      // Truncate all mutable tables so each contract test starts with an empty
      // store. Reference data (users, user_api_keys) is preserved.
      await state.sql`TRUNCATE results, requests, batches, event_log, user_limits, provider_catalog`;
      return new PostgresStore(state.sql);
    },
    () => !state.available,
  );
});
