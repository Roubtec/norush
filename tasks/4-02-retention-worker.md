# Implement Data Retention Worker

## Why this task exists

norush stores prompt/response pairs that may contain sensitive data.
The retention worker enforces configurable data lifecycle policies by scrubbing content after its retention period expires.

## Scope

**Included:**
- Retention worker loop: runs periodically (e.g., every hour) in the worker process
- Per-user retention policy from `user_settings.retention_policy`: `on_ack`, `1d`, `7d`, `30d`, custom
- Scrubbing logic: replace `params` and `response` JSONB with tombstone `{"scrubbed": true, "scrubbed_at": "..."}`
- Preserve metadata: IDs, timestamps, token counts, status (for billing/analytics)
- Scrub `event_log.details` alongside parent records
- System-wide hard upper limit (configurable by operator, e.g., 90 days)
- Idempotent scrubbing (safe to run multiple times)

**Out of scope:**
- Full data deletion (scrub retains metadata)
- GDPR right-to-erasure endpoint (future consideration)
- User-facing retention policy UI (add to existing settings page)

## Context and references

- PLAN.md Section 6.6 (Data Retention) — policy table, scrub definition, implementation notes, hard upper limit
- PLAN.md Section 4.1 (Schema) — `content_scrubbed_at` on `requests` and `results`, `user_settings.retention_policy`
- PLAN.md Section 6.7 (Telemetry) — token counts survive scrubbing

## Target files or areas

```
packages/core/src/
├── workers/
│   └── retention.ts          # Retention scrubbing logic
├── store/
│   └── postgres.ts           # scrubExpiredContent() already defined in Store interface
packages/core/test/
└── workers/
    └── retention.test.ts
```

## Implementation notes

- **Scrubbing query:** For each user, find requests/results where:
  - `content_scrubbed_at IS NULL`
  - Delivery is complete (`delivery_status = 'delivered'` or terminal) OR enough time has passed
  - `created_at + retention_period < NOW()`
- **`on_ack` policy:** Scrub immediately after webhook 2xx ACK (`delivery_status = 'delivered'`).
- **Time-based policies:** Scrub when `created_at + duration < NOW()`.
- **Hard cap:** Even if user sets `retention_policy = '120d'`, operator cap (e.g., 90d) takes precedence. Use `resolveConfig` clamping.
- **Tombstone:** `UPDATE requests SET params = '{"scrubbed": true, "scrubbed_at": "..."}', content_scrubbed_at = NOW() WHERE ...`
- **Event log:** Scrub `details` JSONB on events whose parent entity is scrubbed.
- Wire into the worker process `setInterval` (already running from task 2-05).

### Dependencies

- Requires task 1-03 (Store — `scrubExpiredContent()` interface method).
- Requires task 1-02 (Config — retention policy resolution with operator cap).
- Requires task 2-05 (Worker process — add retention loop).

## Acceptance criteria

- Retention worker runs periodically and scrubs expired content.
- Each retention policy (`on_ack`, `1d`, `7d`, `30d`, custom) is handled correctly.
- Scrubbed records have tombstone JSON in `params`/`response` and `content_scrubbed_at` set.
- Metadata (IDs, timestamps, token counts, status) is preserved after scrubbing.
- Event log details are scrubbed alongside parent records.
- Operator hard cap is enforced.
- Scrubbing is idempotent.
- Unit tests cover all policy types and edge cases.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Create requests with different retention policies. Advance time (or use short policies). Run retention worker → verify correct records are scrubbed.
- Verify scrubbed records still have valid metadata for analytics.
- Run retention worker twice → verify no errors or double-scrubbing.

## Review plan

- Verify tombstone format matches PLAN.md spec.
- Verify operator hard cap is enforced via `resolveConfig`.
- Check that `on_ack` scrubs only after successful delivery.
- Confirm event log details are scrubbed alongside parent records.
