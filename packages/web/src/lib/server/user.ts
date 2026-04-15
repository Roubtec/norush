/**
 * User provisioning: lookup and creation in the database.
 *
 * On first login, creates a `users` row and a `user_settings` row with
 * defaults. Uses the WorkOS user ID as the primary key so the mapping is 1:1.
 *
 * Idempotent: calling provisionUser for an existing user is a no-op.
 */

import type postgres from 'postgres';
import type { SessionUser } from './auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serializable user data safe to expose in layout data and the client. */
export interface PublicUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface DbUser {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function findUser(sql: postgres.Sql, workosId: string): Promise<DbUser | null> {
  const rows = await sql`
    SELECT id, created_at, updated_at FROM users WHERE id = ${workosId}
  `;
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ---------------------------------------------------------------------------
// Provision (create if not exists)
// ---------------------------------------------------------------------------

/**
 * Ensure a user row and user_settings row exist for the given WorkOS user.
 * Returns the user record (existing or newly created).
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency — safe to call
 * on every login without race conditions.
 */
export async function provisionUser(sql: postgres.Sql, sessionUser: SessionUser): Promise<DbUser> {
  const id = sessionUser.workosId;

  // Single transaction: insert user + settings atomically.
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (id)
      VALUES (${id})
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO user_settings (user_id)
      VALUES (${id})
      ON CONFLICT (user_id) DO NOTHING
    `;
  });

  // Always return the (possibly pre-existing) record.
  const user = await findUser(sql, id);
  if (!user) {
    throw new Error(`User provisioning failed for ${id}`);
  }
  return user;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Maps an `App.Locals['user']` to its public serializable shape for use in
 * layout data. Returns null when no user is present.
 */
export function toPublicUser(user: App.Locals['user']): PublicUser | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}
