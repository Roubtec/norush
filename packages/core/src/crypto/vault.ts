/**
 * AES-256-GCM encryption/decryption for API key storage.
 *
 * Each encrypted blob is self-contained:
 *   1-byte version || 12-byte IV || ciphertext || 16-byte GCM auth tag
 *
 * The master key is either a 64-character hex string (32 raw bytes) or
 * a passphrase that is run through HKDF-SHA256 to derive a 32-byte key.
 */

import { createCipheriv, createDecipheriv, randomBytes, hkdf } from "node:crypto";

/** Current envelope version — allows future format changes. */
const ENVELOPE_VERSION = 0x01;

/** IV length for AES-GCM (12 bytes per NIST recommendation). */
const IV_LENGTH = 12;

/** GCM auth tag length in bytes. */
const AUTH_TAG_LENGTH = 16;

/** Expected length of a hex-encoded 32-byte key. */
const HEX_KEY_LENGTH = 64;

/** HKDF info string for key derivation from passphrases. */
const HKDF_INFO = "norush-api-key-vault";

/** HKDF salt — using a fixed salt is acceptable here; the passphrase is the secret. */
const HKDF_SALT = "norush";

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte AES key from the provided master key material.
 *
 * If the input is a 64-character hex string, it is decoded directly.
 * Otherwise, HKDF-SHA256 is used to stretch a passphrase into a key.
 */
export async function deriveKey(masterKey: string): Promise<Buffer> {
  if (!masterKey || masterKey.length === 0) {
    throw new Error("Master key must not be empty");
  }

  // Direct hex key (32 bytes = 64 hex chars)
  if (masterKey.length === HEX_KEY_LENGTH && /^[0-9a-fA-F]+$/.test(masterKey)) {
    return Buffer.from(masterKey, "hex");
  }

  // Passphrase — derive via HKDF
  return new Promise<Buffer>((resolve, reject) => {
    hkdf(
      "sha256",
      masterKey,
      HKDF_SALT,
      HKDF_INFO,
      32,
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(Buffer.from(derivedKey));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

export interface EncryptedPayload {
  /** Self-contained encrypted blob (version + IV + ciphertext + auth tag). */
  blob: Buffer;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 *
 * Returns a self-contained binary blob that can be stored directly in a
 * BYTEA column.
 *
 * @param plaintext - The secret to encrypt (e.g., an API key).
 * @param key - A 32-byte AES key (from `deriveKey`).
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  if (!plaintext || plaintext.length === 0) {
    throw new Error("Plaintext must not be empty");
  }
  if (key.length !== 32) {
    throw new Error("Key must be 32 bytes for AES-256");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Envelope: version(1) || iv(12) || ciphertext(N) || authTag(16)
  const blob = Buffer.concat([
    Buffer.from([ENVELOPE_VERSION]),
    iv,
    encrypted,
    authTag,
  ]);

  return { blob };
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

/**
 * Decrypt an encrypted blob back to the original plaintext.
 *
 * @param blob - The self-contained encrypted blob from `encrypt`.
 * @param key - The same 32-byte AES key used for encryption.
 * @returns The original plaintext string.
 * @throws If the blob is malformed, the key is wrong, or data was tampered with.
 */
export function decrypt(blob: Buffer, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error("Key must be 32 bytes for AES-256");
  }

  // Minimum size: version(1) + IV(12) + authTag(16) + at least 1 byte ciphertext
  const minLength = 1 + IV_LENGTH + AUTH_TAG_LENGTH + 1;
  if (!blob || blob.length < minLength) {
    throw new Error("Encrypted blob is too short or missing");
  }

  const version = blob[0];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${version}`);
  }

  const iv = blob.subarray(1, 1 + IV_LENGTH);
  const authTag = blob.subarray(blob.length - AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(1 + IV_LENGTH, blob.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error("Decryption failed — wrong key or corrupted data");
  }
}

// ---------------------------------------------------------------------------
// Masking utility
// ---------------------------------------------------------------------------

/**
 * Mask an API key for display, showing only a prefix hint.
 *
 * Examples:
 *   "sk-ant-api03-abcdef...xyz" -> "sk-ant-...****"
 *   "sk-proj-abc123"            -> "sk-pr...****"
 *
 * @param key - The plaintext API key.
 * @param prefixLength - Number of characters to reveal at the start (default 6).
 */
export function maskApiKey(key: string, prefixLength = 6): string {
  if (key.length <= prefixLength) {
    return "****";
  }
  return key.slice(0, prefixLength) + "...****";
}
