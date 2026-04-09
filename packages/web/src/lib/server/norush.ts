/**
 * Singleton norush engine instance for server routes.
 *
 * Lazily initializes a PostgresStore + NorushEngine on first access.
 * Import this module from any server route to interact with the engine.
 */

import postgres from "postgres";
import { PostgresStore, migrate, createNorush, type NorushEngine } from "@norush/core";

let engine: NorushEngine | undefined;
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
 */
export async function getEngine(): Promise<NorushEngine> {
  if (!engine) {
    const db = getSql();
    await migrate(db);
    const store = new PostgresStore(db);

    engine = createNorush({
      store,
      providers: {},
    });
  }
  return engine;
}
