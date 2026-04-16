/**
 * API key CRUD operations with encryption/decryption.
 *
 * Uses the @norush/core vault module for AES-256-GCM encryption.
 * Queries the `user_api_keys` table directly via postgres.js.
 *
 * Plaintext keys are never stored, logged, or returned after initial encryption.
 * Callers receive masked representations for display.
 */

import type postgres from 'postgres';
import { env } from '$env/dynamic/private';
import { encrypt, decrypt, deriveKey, maskApiKey } from '@norush/core';
import { ulid } from 'ulidx';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An API key record as exposed to the UI (never includes plaintext). */
export interface ApiKeyRecord {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  priority: number;
  failoverEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a new API key. */
export interface CreateApiKeyInput {
  userId: string;
  provider: string;
  label: string;
  apiKey: string;
  priority?: number;
  failoverEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Master key
// ---------------------------------------------------------------------------

let _masterKeyBuffer: Buffer | null = null;

/**
 * Get or derive the master encryption key from NORUSH_MASTER_KEY env var.
 * Caches the derived key in memory for the process lifetime.
 */
async function getMasterKey(): Promise<Buffer> {
  if (_masterKeyBuffer) return _masterKeyBuffer;

  const raw = env.NORUSH_MASTER_KEY;
  if (!raw) {
    throw new Error('NORUSH_MASTER_KEY environment variable is required for API key encryption');
  }

  _masterKeyBuffer = await deriveKey(raw);
  return _masterKeyBuffer;
}

/** Reset the cached master key (for testing). */
export function resetMasterKey(): void {
  _masterKeyBuffer = null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_PROVIDERS = ['claude', 'openai'] as const;

/** Known API key prefixes per provider for basic validation. */
const KEY_PREFIXES: Record<string, string[]> = {
  claude: ['sk-ant-'],
  openai: ['sk-'],
};

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate API key creation input.
 * Returns an array of validation errors (empty if valid).
 */
export function validateApiKeyInput(input: {
  provider: string;
  label: string;
  apiKey: string;
}): ValidationError[] {
  const errors: ValidationError[] = [];

  // Provider
  if (!input.provider) {
    errors.push({ field: 'provider', message: 'Provider is required' });
  } else if (!VALID_PROVIDERS.includes(input.provider as (typeof VALID_PROVIDERS)[number])) {
    errors.push({
      field: 'provider',
      message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}`,
    });
  }

  // Label — validate the trimmed value (consistent with what is stored)
  const label = input.label?.trim() ?? '';
  if (label.length === 0) {
    errors.push({ field: 'label', message: 'Label is required' });
  } else if (label.length > 100) {
    errors.push({ field: 'label', message: 'Label must be 100 characters or fewer' });
  }

  // API key — normalize before all checks (consistent with what is stored)
  const apiKey = input.apiKey?.trim() ?? '';
  if (apiKey.length === 0) {
    errors.push({ field: 'apiKey', message: 'API key is required' });
  } else if (apiKey.length < 10) {
    errors.push({ field: 'apiKey', message: 'API key appears too short' });
  } else if (input.provider && KEY_PREFIXES[input.provider]) {
    const prefixes = KEY_PREFIXES[input.provider];
    const hasValidPrefix = prefixes.some((p) => apiKey.startsWith(p));
    if (!hasValidPrefix) {
      errors.push({
        field: 'apiKey',
        message: `API key should start with one of: ${prefixes.join(', ')}`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * List all API keys for a user (masked — no plaintext returned).
 */
export async function listApiKeys(sql: postgres.Sql, userId: string): Promise<ApiKeyRecord[]> {
  const masterKey = await getMasterKey();

  const rows = await sql`
    SELECT id, provider, label, api_key_encrypted, priority, failover_enabled,
           created_at, updated_at
    FROM user_api_keys
    WHERE user_id = ${userId}
    ORDER BY provider, priority, created_at
  `;

  return rows.map((row) => {
    const maskedKey = (() => {
      try {
        const plaintext = decrypt(Buffer.from(row.api_key_encrypted as Uint8Array), masterKey);
        return maskApiKey(plaintext);
      } catch {
        // If decryption fails (e.g. key rotated), show a generic mask
        return '[decryption error]';
      }
    })();

    return {
      id: row.id as string,
      provider: row.provider as string,
      label: row.label as string,
      maskedKey,
      priority: row.priority as number,
      failoverEnabled: row.failover_enabled as boolean,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  });
}

/**
 * Create a new API key record with encrypted storage.
 *
 * @returns The created record (with masked key, never plaintext).
 */
export async function createApiKey(
  sql: postgres.Sql,
  input: CreateApiKeyInput,
): Promise<ApiKeyRecord> {
  const masterKey = await getMasterKey();
  const { blob } = encrypt(input.apiKey, masterKey);

  const id = ulid();
  const priority = input.priority ?? 0;
  const failoverEnabled = input.failoverEnabled ?? true;

  await sql`
    INSERT INTO user_api_keys (id, user_id, provider, label, api_key_encrypted, priority, failover_enabled)
    VALUES (${id}, ${input.userId}, ${input.provider}, ${input.label}, ${blob}, ${priority}, ${failoverEnabled})
  `;

  return {
    id,
    provider: input.provider,
    label: input.label,
    maskedKey: maskApiKey(input.apiKey),
    priority,
    failoverEnabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Delete an API key record belonging to the specified user.
 *
 * @returns true if a record was deleted, false if not found.
 */
export async function deleteApiKey(
  sql: postgres.Sql,
  userId: string,
  keyId: string,
): Promise<boolean> {
  const result = await sql`
    DELETE FROM user_api_keys
    WHERE id = ${keyId} AND user_id = ${userId}
  `;
  return result.count > 0;
}

/**
 * Decrypt an API key for use at batch submission time.
 *
 * This is the ONLY function that returns plaintext and should be called
 * exclusively by the batch manager when building provider requests.
 */
export async function decryptApiKey(
  sql: postgres.Sql,
  userId: string,
  keyId: string,
): Promise<string> {
  const masterKey = await getMasterKey();

  const rows = await sql`
    SELECT api_key_encrypted FROM user_api_keys WHERE id = ${keyId} AND user_id = ${userId}
  `;

  if (rows.length === 0) {
    throw new Error(`API key not found: ${keyId}`);
  }

  return decrypt(Buffer.from(rows[0].api_key_encrypted as Uint8Array), masterKey);
}
