# Implement Master Key Rotation CLI

## Why this task exists

The `NORUSH_MASTER_KEY` encrypts all stored API keys.
Operators need a way to rotate this key periodically without losing access to existing encrypted data.

## Scope

**Included:**
- CLI command: `norush rotate-key --old-key <hex> --new-key <hex>`
- Re-encrypts all `user_api_keys.api_key_encrypted` records from old key to new key
- Runs in a transaction: all-or-nothing re-encryption
- Progress output: number of keys re-encrypted
- Dry-run mode: `--dry-run` verifies all keys decrypt successfully without writing

**Out of scope:**
- Automatic key rotation scheduling
- Key age UI notification (nice-to-have, not critical)
- HSM or Azure Key Vault integration

## Context and references

- PLAN.md Section 6.6 (Encryption at Rest) — manual key rotation, CLI command, re-encryption

## Target files or areas

```
packages/core/src/
├── cli/
│   └── rotate-key.ts        # CLI entry point
├── crypto/
│   └── vault.ts             # encrypt/decrypt (already exists from task 2-03)
packages/core/bin/
└── norush.ts                 # CLI dispatcher (or add to existing)
```

## Implementation notes

- **Algorithm:** For each record in `user_api_keys`: decrypt with old key → encrypt with new key → update row.
- **Transaction:** Wrap the entire operation in a database transaction. If any decryption fails (wrong old key), abort.
- **Dry-run:** Decrypt all keys with the old key to verify they're valid. Report count and any failures. Don't write anything.
- **CLI interface:** Can use a simple argument parser (no heavy CLI framework needed). The command connects to the database via `DATABASE_URL`.
- **Safety:** Require both `--old-key` and `--new-key` to prevent accidents. Refuse to run if they're the same.
- Add a `bin` entry in `package.json` so `npx norush rotate-key` works after npm publish.

### Dependencies

- Requires task 2-03 (crypto vault module).
- Requires task 1-03 (Store — database access).

## Acceptance criteria

- `norush rotate-key --old-key X --new-key Y` re-encrypts all API keys.
- All keys decrypt correctly with the new key after rotation.
- Operation is atomic: partial failure rolls back.
- `--dry-run` reports success/failure without modifying data.
- Same old and new key is rejected.
- Invalid old key (decryption failure) aborts the operation.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Store several API keys with one master key. Run rotation. Verify all keys decrypt with new key.
- Run with wrong old key → verify abort with clear error message.
- Run `--dry-run` → verify no database changes.
- After rotation, verify the application works with the new `NORUSH_MASTER_KEY`.

## Review plan

- Verify transaction wraps the entire operation.
- Verify dry-run truly makes no writes.
- Verify old key is not logged or persisted anywhere.
- Check that the CLI is accessible via package bin entry.
