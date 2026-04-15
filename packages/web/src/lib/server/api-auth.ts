/**
 * API token authentication for the REST API (/api/v1/).
 *
 * Tokens are random 32-byte hex strings prefixed with "nrsh_".
 * Only a SHA-256 hash is stored; the plaintext is shown once at creation.
 *
 * Usage in route handlers:
 *   const authHeader = request.headers.get("authorization");
 *   const caller = await authenticateApiRequest(sql, authHeader);
 *   // caller is { userId, tokenId } on success, or null on failure.
 */

import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { ulid } from 'ulidx';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = 'nrsh_';
const TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Authenticated API caller identity. */
export interface ApiCaller {
  userId: string;
  tokenId: string;
}

/** A newly created token (plaintext shown only once). */
export interface CreatedToken {
  id: string;
  token: string;
  tokenPrefix: string;
  label: string;
  createdAt: Date;
}

/** A token record for listing (never includes plaintext). */
export interface ApiTokenRecord {
  id: string;
  label: string;
  tokenPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Token generation and hashing
// ---------------------------------------------------------------------------

/** Generate a new raw API token string. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex');
}

/** Hash a raw token for storage comparison. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Extract the display prefix from a raw token. */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 8);
}

// ---------------------------------------------------------------------------
// Validate a bearer token from an Authorization header
// ---------------------------------------------------------------------------

/**
 * Validate an API bearer token and return the caller identity.
 * Returns null if the token is invalid, expired, or revoked.
 *
 * Side-effect: updates `last_used_at` on successful validation.
 */
export async function validateApiToken(
  sql: postgres.Sql,
  rawToken: string,
): Promise<ApiCaller | null> {
  const hash = hashToken(rawToken);

  const rows = await sql`
    SELECT id, user_id, expires_at, revoked_at
    FROM api_tokens
    WHERE token_hash = ${hash}
  `;

  if (rows.length === 0) return null;

  const row = rows[0];

  // Check revocation
  if (row.revoked_at) return null;

  // Check expiration
  if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
    return null;
  }

  // Update last_used_at (fire-and-forget — don't block the request)
  void sql`
    UPDATE api_tokens SET last_used_at = now() WHERE id = ${row.id as string}
  `.catch(() => {
    // Ignore update failures — non-critical
  });

  return {
    userId: row.user_id as string,
    tokenId: row.id as string,
  };
}

// ---------------------------------------------------------------------------
// Extract bearer token from Authorization header
// ---------------------------------------------------------------------------

/**
 * Parse the Authorization header and extract the bearer token.
 * Returns null if the header is missing or malformed.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

// ---------------------------------------------------------------------------
// Authenticate a request (convenience wrapper for route handlers)
// ---------------------------------------------------------------------------

/**
 * Authenticate an API request from its Authorization header.
 * Returns the caller identity or null if authentication fails.
 */
export async function authenticateApiRequest(
  sql: postgres.Sql,
  authHeader: string | null,
): Promise<ApiCaller | null> {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  return validateApiToken(sql, token);
}

// ---------------------------------------------------------------------------
// CRUD: create / list / revoke tokens
// ---------------------------------------------------------------------------

/**
 * Create a new API token for a user.
 * Returns the created token including the plaintext (shown only once).
 */
export async function createApiToken(
  sql: postgres.Sql,
  userId: string,
  label = 'default',
): Promise<CreatedToken> {
  const id = ulid();
  const rawToken = generateToken();
  const hash = hashToken(rawToken);
  const prefix = tokenDisplayPrefix(rawToken);

  await sql`
    INSERT INTO api_tokens (id, user_id, label, token_hash, token_prefix)
    VALUES (${id}, ${userId}, ${label}, ${hash}, ${prefix})
  `;

  return {
    id,
    token: rawToken,
    tokenPrefix: prefix,
    label,
    createdAt: new Date(),
  };
}

/**
 * List all API tokens for a user (no plaintext).
 */
export async function listApiTokens(sql: postgres.Sql, userId: string): Promise<ApiTokenRecord[]> {
  const rows = await sql`
    SELECT id, label, token_prefix, last_used_at, expires_at, revoked_at, created_at
    FROM api_tokens
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;

  return rows.map((row) => ({
    id: row.id as string,
    label: row.label as string,
    tokenPrefix: row.token_prefix as string,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    createdAt: new Date(row.created_at as string),
  }));
}

/**
 * Revoke an API token. Sets revoked_at to now().
 * Returns true if the token was found and revoked, false if not found.
 */
export async function revokeApiToken(
  sql: postgres.Sql,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE api_tokens
    SET revoked_at = now()
    WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL
  `;
  return result.count > 0;
}
