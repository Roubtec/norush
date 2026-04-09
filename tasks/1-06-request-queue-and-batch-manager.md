# Implement Request Queue and Batch Manager

## Why this task exists

The Request Queue accepts individual prompt requests and the Batch Manager groups and submits them to providers.
Together they form the ingress pipeline — the path from "user submits a request" to "batch is sent to provider."

## Scope

**Included:**
- **Request Queue:** Accept requests, assign ULID `norush_id`, persist to store, trigger batch flush
- **Flush triggers:** count threshold, byte limit, time window, manual flush
- **Batch Manager:** Group queued requests by `(provider, model, api_key_id)`, format for provider, submit
- **Write-before-submit idempotency:** Create batch record with `status: 'pending'` before calling provider API
- Unit tests for queue acceptance, grouping logic, flush triggers, and submission protocol

**Out of scope:**
- Orphan recovery (task 1-07 — Status Tracker)
- Circuit breaker (task 1-07)
- Result handling (task 1-08)
- Rate limiting / spend controls (Phase 3)

## Context and references

- PLAN.md Section 3.2 (Components) — Request Queue and Batch Manager descriptions
- PLAN.md Section 3.4 (Library Configuration) — batching config: `maxRequests`, `maxBytes`, `flushIntervalMs`
- PLAN.md Section 6.1 (Request & Batch Lifecycle) — key isolation, write-before-submit protocol, submission steps 1-4

## Target files or areas

```
packages/core/src/
├── engine/
│   ├── queue.ts            # Request Queue
│   ├── batch-manager.ts    # Batch Manager
│   └── index.ts
packages/core/test/
└── engine/
    ├── queue.test.ts
    └── batch-manager.test.ts
```

## Implementation notes

- **Request Queue:**
  - `enqueue(request)` → assigns ULID, persists via `store.createRequest()`, checks flush triggers.
  - Flush triggers are configured via `batching` config (from task 1-02): `maxRequests`, `maxBytes`, `flushIntervalMs`.
  - When a trigger fires, the queue calls the Batch Manager to form and submit batches.
  - `flushIntervalMs` uses `setInterval` (or is driven externally via `tick()`).

- **Batch Manager:**
  - Reads queued requests from store (`store.getQueuedRequests()`).
  - Groups by `(provider, model, api_key_id)` — separate batches per API key (PLAN.md Section 6.1).
  - Respects provider limits: 100K requests / 256MB for Claude, 50K / 200MB for OpenAI.
  - Calls the appropriate `Provider` adapter's `submitBatch()`.
  - **Write-before-submit:** (1) Create batch record `status: 'pending'`, `submission_attempts: 0`. (2) Increment to 1, call provider. (3) On success, update `provider_batch_id` and `status: 'submitted'`. (4) On failure, leave `provider_batch_id` NULL.
  - Updates all request records with `batch_id` and `status: 'batched'`.

- The queue and batch manager should accept a `Store` and `Provider` map as constructor/factory dependencies (dependency injection for testability).
- Telemetry hooks: emit `requests_queued` and `batches_submitted` counters.

### Dependencies

- Requires task 1-02 (types, config, telemetry).
- Requires task 1-03 (Store implementations for testing).
- Requires task 1-05 (Provider adapters for submission).

## Acceptance criteria

- `enqueue()` persists a request with ULID and `status: 'queued'`.
- Flush triggers fire at correct thresholds (count, bytes, time).
- Batch Manager groups requests correctly by `(provider, model, api_key_id)`.
- Write-before-submit protocol is followed: batch record exists before provider call.
- On submission success, batch has `provider_batch_id` and `status: 'submitted'`.
- On submission failure, batch has NULL `provider_batch_id` and remains `pending`.
- Provider batch size limits are respected (batches split if too large).
- Unit tests cover: single-request flush, multi-group batching, size-based splitting, submission success/failure paths.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all queue and batch manager tests.
- Trace through the write-before-submit flow in tests to verify ordering.

## Review plan

- Verify write-before-submit matches PLAN.md Section 6.1 steps 1-4 exactly.
- Verify grouping key is `(provider, model, api_key_id)` — not just `(provider, model)`.
- Check that provider size limits are enforced.
- Confirm telemetry hooks are called.
