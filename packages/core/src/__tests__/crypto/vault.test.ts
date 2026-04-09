/**
 * Vault encrypt/decrypt unit tests.
 *
 * Covers: round-trip correctness, unique IVs, wrong-key failure,
 * empty/malformed input rejection, and masking utility.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, deriveKey, maskApiKey } from "../../crypto/vault.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-byte key for testing. */
function testKey(): Buffer {
  return randomBytes(32);
}

// ---------------------------------------------------------------------------
// deriveKey
// ---------------------------------------------------------------------------

describe("deriveKey", () => {
  it("decodes a 64-char hex string directly as 32 bytes", async () => {
    const hex = "a".repeat(64);
    const key = await deriveKey(hex);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(hex);
  });

  it("derives a 32-byte key from a passphrase via HKDF", async () => {
    const key = await deriveKey("my-secret-passphrase");
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("produces the same key for the same passphrase (deterministic)", async () => {
    const k1 = await deriveKey("repeat-me");
    const k2 = await deriveKey("repeat-me");
    expect(k1.equals(k2)).toBe(true);
  });

  it("produces different keys for different passphrases", async () => {
    const k1 = await deriveKey("passphrase-one");
    const k2 = await deriveKey("passphrase-two");
    expect(k1.equals(k2)).toBe(false);
  });

  it("throws on empty master key", async () => {
    await expect(deriveKey("")).rejects.toThrow("Master key must not be empty");
  });
});

// ---------------------------------------------------------------------------
// encrypt / decrypt round-trip
// ---------------------------------------------------------------------------

describe("encrypt + decrypt round-trip", () => {
  it("recovers the original plaintext", () => {
    const key = testKey();
    const plaintext = "sk-ant-api03-abcdef1234567890";
    const { blob } = encrypt(plaintext, key);
    const recovered = decrypt(blob, key);
    expect(recovered).toBe(plaintext);
  });

  it("works with unicode content", () => {
    const key = testKey();
    const plaintext = "key-with-unicode-\u00e9\u00e8\u00ea-\u{1F511}";
    const { blob } = encrypt(plaintext, key);
    const recovered = decrypt(blob, key);
    expect(recovered).toBe(plaintext);
  });

  it("works with a very long key string", () => {
    const key = testKey();
    const plaintext = "x".repeat(10_000);
    const { blob } = encrypt(plaintext, key);
    expect(decrypt(blob, key)).toBe(plaintext);
  });

  it("works end-to-end with deriveKey from hex", async () => {
    const hex = randomBytes(32).toString("hex");
    const key = await deriveKey(hex);
    const plaintext = "sk-proj-abcdef";
    const { blob } = encrypt(plaintext, key);
    expect(decrypt(blob, key)).toBe(plaintext);
  });

  it("works end-to-end with deriveKey from passphrase", async () => {
    const key = await deriveKey("my-secure-passphrase");
    const plaintext = "sk-proj-abcdef";
    const { blob } = encrypt(plaintext, key);
    expect(decrypt(blob, key)).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// IV uniqueness
// ---------------------------------------------------------------------------

describe("IV uniqueness", () => {
  it("generates a unique IV for each encryption", () => {
    const key = testKey();
    const plaintext = "same-key-same-plaintext";

    const { blob: blob1 } = encrypt(plaintext, key);
    const { blob: blob2 } = encrypt(plaintext, key);

    // Blobs should differ because of different random IVs
    expect(blob1.equals(blob2)).toBe(false);

    // Extract IVs (bytes 1..13) and compare
    const iv1 = blob1.subarray(1, 13);
    const iv2 = blob2.subarray(1, 13);
    expect(iv1.equals(iv2)).toBe(false);

    // But both should decrypt to the same plaintext
    expect(decrypt(blob1, key)).toBe(plaintext);
    expect(decrypt(blob2, key)).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Decryption with wrong key
// ---------------------------------------------------------------------------

describe("wrong key decryption", () => {
  it("fails with a different key", () => {
    const key1 = testKey();
    const key2 = testKey();
    const { blob } = encrypt("secret-api-key", key1);

    expect(() => decrypt(blob, key2)).toThrow("Decryption failed");
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("rejects empty plaintext", () => {
    const key = testKey();
    expect(() => encrypt("", key)).toThrow("Plaintext must not be empty");
  });

  it("rejects key that is not 32 bytes (encrypt)", () => {
    const badKey = Buffer.alloc(16);
    expect(() => encrypt("test", badKey)).toThrow("Key must be 32 bytes");
  });

  it("rejects key that is not 32 bytes (decrypt)", () => {
    const key = testKey();
    const { blob } = encrypt("test", key);
    const badKey = Buffer.alloc(16);
    expect(() => decrypt(blob, badKey)).toThrow("Key must be 32 bytes");
  });

  it("rejects a blob that is too short", () => {
    const key = testKey();
    const shortBlob = Buffer.alloc(5);
    expect(() => decrypt(shortBlob, key)).toThrow("too short");
  });

  it("rejects a blob with unsupported version", () => {
    const key = testKey();
    const { blob } = encrypt("test", key);
    // Corrupt the version byte
    const corrupted = Buffer.from(blob);
    corrupted[0] = 0xff;
    expect(() => decrypt(corrupted, key)).toThrow("Unsupported envelope version");
  });

  it("rejects a tampered blob", () => {
    const key = testKey();
    const { blob } = encrypt("test", key);
    // Flip a bit in the ciphertext
    const tampered = Buffer.from(blob);
    tampered[15] ^= 0xff;
    expect(() => decrypt(tampered, key)).toThrow("Decryption failed");
  });
});

// ---------------------------------------------------------------------------
// maskApiKey
// ---------------------------------------------------------------------------

describe("maskApiKey", () => {
  it("masks a long key showing only the prefix", () => {
    expect(maskApiKey("sk-ant-api03-abcdef1234567890")).toBe("sk-ant...****");
  });

  it("masks with custom prefix length", () => {
    expect(maskApiKey("sk-proj-abcdef1234567890", 8)).toBe("sk-proj-...****");
  });

  it("returns **** for keys shorter than or equal to prefix length", () => {
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("123456")).toBe("****");
  });

  it("handles a key just above the prefix length", () => {
    expect(maskApiKey("1234567")).toBe("123456...****");
  });
});
