/**
 * Singleton norush engine instance for server routes.
 *
 * Lazily initializes a PostgresStore + NorushEngine on first access.
 * Import this module from any server route to interact with the engine.
 */

import postgres from "postgres";
import { PostgresStore, migrate, createNorush, type NorushEngine } from "@norush/core";

let store: PostgresStore | undefined;
let sql: postgres.Sql | undefined;

/**
 * Return the shared postgres.js connection.
 * Creates one on first call using DATABASE_URL from the environment.
 */
export function getSql(): postgres.Sql {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    sql = postgres(url);
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
      return createNorush({
        store,
        providers: {},
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
    throw new Error("Store not initialized. Call getEngine() first.");
  }
  return store;
}
