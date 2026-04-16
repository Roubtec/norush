/**
 * Singleton norush engine instance for server routes.
 *
 * Lazily initializes a PostgresStore + NorushEngine on first access.
 * Import this module from any server route to interact with the engine.
 */

import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import { PostgresStore, migrate, createNorush, type NorushEngine } from '@norush/core';
import { startCatalogRefresh } from './catalog';

function optionalEnvInt(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) {
    console.warn(`[norush] ${name} has invalid integer value "${value}", using default`);
    return undefined;
  }
  return n;
}

let store: PostgresStore | undefined;
let sql: postgres.Sql | undefined;

/**
 * Return the shared postgres.js connection.
 * Creates one on first call using DATABASE_URL from the environment.
 */
export function getSql(): postgres.Sql {
  if (!sql) {
    const url = env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    sql = postgres(url, {
      onnotice: (notice) => {
        console.log(`[postgres] ${notice.severity ?? 'NOTICE'} ${JSON.stringify(notice)}`);
      },
    });
  }
  return sql;
}

/**
 * Return the shared NorushEngine.
 * Initializes database migrations and engine on first call.
 *
 * Uses a shared Promise so concurrent calls during startup share one
 * initialization path rather than racing to run migrations in parallel.
 */
let engineInit: Promise<NorushEngine> | undefined;

export async function getEngine(): Promise<NorushEngine> {
  if (!engineInit) {
    engineInit = (async () => {
      const db = getSql();
      await migrate(db);
      store = new PostgresStore(db);

      // Kick off the scheduled provider-catalog refresh. It runs one fetch
      // immediately and then repeats on a jittered ~hourly interval. The
      // call is idempotent, so a second `getEngine()` in the same process
      // is a no-op.
      try {
        startCatalogRefresh(store);
      } catch (err) {
        console.error('[norush] Failed to start catalog refresh loop:', err);
      }

      return createNorush({
        store,
        providers: {},
        batching: {
          flushIntervalMs: optionalEnvInt('NORUSH_FLUSH_INTERVAL_MS', env.NORUSH_FLUSH_INTERVAL_MS),
          maxRequests: optionalEnvInt('NORUSH_MAX_REQUESTS', env.NORUSH_MAX_REQUESTS),
        },
        polling: {
          intervalMs: optionalEnvInt('NORUSH_POLL_INTERVAL_MS', env.NORUSH_POLL_INTERVAL_MS),
        },
        delivery: {
          tickIntervalMs: optionalEnvInt(
            'NORUSH_DELIVERY_INTERVAL_MS',
            env.NORUSH_DELIVERY_INTERVAL_MS,
          ),
        },
      });
    })();
  }
  return engineInit;
}

/**
 * Return the shared PostgresStore instance.
 * Must be called after getEngine() has been called at least once.
 */
export function getStore(): PostgresStore {
  if (!store) {
    throw new Error('Store not initialized. Call getEngine() first.');
  }
  return store;
}
