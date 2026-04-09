# Implement Multi-Token Failover and User-Triggered Re-Submission

## Why this task exists

Users with multiple API keys per provider need automatic failover when one key hits rate limits or credit exhaustion.
Users also need the ability to manually re-trigger failed requests.

## Scope

**Included:**
- Multi-token failover in the Batch Manager: try primary key, fall back to next on failure
- Key priority ordering and `failover_enabled` flag per key
- Key selection recording on batch record (`api_key_id`, `api_key_label`)
- `POST /api/v1/requests/:id/retry` — user-triggered re-submission of terminal requests
- User re-submission resets `retry_count` to 0, sets `status` back to `queued`
- Constrained by spend limits (Phase 3 task 3-04), not by retry budget

**Out of scope:**
- Automatic key rotation or provisioning
- Key health tracking / smart routing (future optimization)

## Context and references

- PLAN.md Section 6.4 (Multi-Token Failover) — priority, failover behavior, key selection recording
- PLAN.md Section 6.1 (User-Triggered Re-Submission) — reset retry_count, back to queued, spend-limited

## Target files or areas

```
packages/core/src/
├── engine/
│   └── batch-manager.ts      # Extend with failover logic
├── keys/
│   └── selector.ts           # Key selection with priority and failover
packages/core/test/
├── keys/
│   └── selector.test.ts
packages/web/src/
└── routes/
    └── api/v1/requests/[id]/
        └── retry/
            └── +server.ts    # POST: user-triggered re-submission
```

## Implementation notes

- **Key selection:** When forming a batch for a user + provider combination:
  1. Load user's keys for that provider, ordered by `priority` (lower = first).
  2. Attempt submission with the primary key.
  3. On rate limit (429) or credit exhaustion error, try the next key (if `failover_enabled` on both keys).
  4. If all keys exhausted, follow normal retry/failure flow.
  5. Record which key was used on the batch record (`api_key_id`, `api_key_label`).

- **User re-submission (`POST /api/v1/requests/:id/retry`):**
  - Only allowed for terminal states: `failed_final`, `canceled`.
  - Resets `retry_count` to 0, `status` to `queued`, clears `batch_id`.
  - The request will be picked up by the Batch Manager on the next flush.
  - Must still pass spend limit checks (task 3-04).

- **Failover is per-submission-attempt**, not per-batch-lifecycle. If the primary key fails on initial submit, try backup. If the batch later expires and gets repackaged, start key selection from primary again.

### Dependencies

- Requires task 1-06 (Batch Manager to extend).
- Requires task 2-03 (API key vault — decrypt keys for submission).
- Requires task 3-01 (REST API — for the retry endpoint).

## Acceptance criteria

- Batch submission tries keys in priority order.
- On primary key failure (429/credit), automatically falls back to next key.
- Failover respects `failover_enabled` flag — disabled keys are skipped.
- Key used is recorded on the batch record.
- User can re-trigger a `failed_final` request via API.
- Re-triggered request has `retry_count: 0`, `status: 'queued'`.
- Re-submission of non-terminal requests returns an error.
- Unit tests cover: key selection order, failover on 429, all keys exhausted, re-submission state transitions.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Configure two keys for a provider. Mock primary returning 429 → verify fallback key is used and recorded.
- Re-trigger a failed request → verify it appears as queued with reset retry count.
- Attempt re-trigger on an active request → verify 400 error.

## Review plan

- Verify key selection order matches priority field.
- Verify failover only triggers on rate limit / credit errors (not all errors).
- Verify re-submission resets the right fields and nothing else.
- Check that key decryption happens at submission time, not earlier.
