/**
 * Crypto module re-exports.
 *
 * The vault provides AES-256-GCM encryption/decryption for API keys.
 */

export {
  deriveKey,
  encrypt,
  decrypt,
  maskApiKey,
  type EncryptedPayload,
} from "./vault.js";
