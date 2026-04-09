# Implement API Key Encryption and Management UI

## Why this task exists

Users provide their own Anthropic and OpenAI API keys.
These keys must be encrypted at rest (AES-256-GCM) and manageable through a settings page.

## Scope

**Included:**
- AES-256-GCM encryption/decryption module using `NORUSH_MASTER_KEY` env var
- Encrypt API keys before storing in `user_api_keys` table
- Decrypt API keys at batch submission time (when provider adapter needs them)
- Settings page: add, view (masked), and delete API keys per provider
- Label and priority fields for multi-key support
- Server-side validation: reject empty or obviously malformed keys

**Out of scope:**
- Multi-token failover logic (Phase 3 — task 3-03)
- Master key rotation CLI (Phase 4)
- Key age notifications (Phase 4)

## Context and references

- PLAN.md Section 6.6 (Encryption at Rest) — AES-256-GCM, master key via env var, unique IV per record
- PLAN.md Section 5.1 (norush.chat) — user flow step 2: add API keys
- PLAN.md Section 4.1 (Schema) — `user_api_keys` table: `api_key_encrypted BYTEA`, provider, label, priority, failover_enabled

## Target files or areas

```
packages/core/src/
├── crypto/
│   ├── vault.ts              # encrypt(plaintext, masterKey) → { iv, ciphertext }
│   └── index.ts              #   decrypt({ iv, ciphertext }, masterKey) → plaintext
packages/web/src/
├── routes/
│   └── (app)/
│       └── settings/
│           ├── +page.svelte          # API key management UI
│           └── +page.server.ts       # Server actions: add, delete keys
├── lib/
│   └── server/
│       └── api-keys.ts       # CRUD operations with encryption/decryption
```

## Implementation notes

- **Encryption:** Use Node.js built-in `crypto` module. AES-256-GCM with a random 12-byte IV per record. Store IV + ciphertext + auth tag together in the `api_key_encrypted` BYTEA column. The master key is derived from `NORUSH_MASTER_KEY` (hex-encoded 32-byte key or use HKDF if a passphrase).
- **Decryption** happens only at batch submission time — the vault module is in `@norush/core` so the Batch Manager can decrypt keys when building provider requests.
- **Settings UI:** Show a table of configured keys with provider, label, and a masked display (e.g., `sk-ant-...****`). Add form with provider dropdown, label text input, and key text input (type=password). Delete button per key.
- **Server actions:** Use SvelteKit form actions for add/delete. Validate key is non-empty. Encrypt before storing.
- Never log or return plaintext API keys in responses after storage.

### Dependencies

- Requires task 2-01 (SvelteKit scaffold).
- Requires task 2-02 (Auth — user must be logged in to manage keys).
- Requires task 1-03 (Store — `user_api_keys` table).

## Acceptance criteria

- API keys are encrypted with AES-256-GCM before storage; plaintext is never in the database.
- Each key record has a unique IV.
- Decryption correctly recovers the original key.
- Settings page lists existing keys (masked) and allows add/delete.
- Adding a key stores encrypted bytes in `user_api_keys`.
- Deleting a key removes the record.
- API keys are never exposed in plaintext in HTTP responses, logs, or client-side code.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Add a key via the UI → verify `user_api_keys` row has non-null `api_key_encrypted` that is not the plaintext.
- Decrypt the stored key programmatically → verify it matches the original.
- Delete a key via the UI → verify row is removed.
- Verify masked display shows only a prefix/suffix hint.

## Review plan

- Verify AES-256-GCM is used with random IV per record (not a fixed IV).
- Verify master key is read from env var, not hardcoded.
- Verify plaintext keys are never logged or returned after storage.
- Check that the crypto module is in `@norush/core` (not web-only) so the worker can decrypt.
