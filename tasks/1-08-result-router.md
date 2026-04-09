# Implement Result Router and Request Repackaging

## Why this task exists

Once a batch completes, individual results must be ingested (persisted crash-safely) and then delivered to consumers (callbacks, events).
Failed or expired requests must be automatically repackaged into new batches.
This task completes the core engine's request lifecycle.

## Scope

**Included:**
- **Phase A — Ingestion:** Stream results from provider one at a time, persist each to store immediately
- **Phase B — Delivery:** Read undelivered results, fan out via callbacks and event emitter, track delivery attempts with retry/backoff
- **Repackaging:** Collect failed/expired requests where `retry_count < max_provider_retries`, create new batch
- Delivery status tracking: `pending` → `delivered` / `failed`
- Exponential backoff for delivery retries: 10s → 20s → 40s → ... capped at 10min, up to `max_delivery_attempts`
- Unit tests with MemoryStore and mocked providers

**Out of scope:**
- Webhook delivery with HMAC signing (Phase 3 — task 3-02)
- User-triggered re-submission via API (Phase 3 — task 3-03)
- Notification system (Phase 2)

## Context and references

- PLAN.md Section 6.2 (Result Pipeline) — two-phase streaming architecture, crash safety rationale
- PLAN.md Section 6.2 (OpenAI Output File Handling) — line-by-line parsing
- PLAN.md Section 6.1 (Partial Batch Failures & Repackaging) — per-request outcomes, retry budget, `failed_final` transition
- PLAN.md Section 3.2 (Components) — Result Router description

## Target files or areas

```
packages/core/src/
├── engine/
│   ├── result-ingester.ts    # Phase A: stream → store
│   ├── delivery-worker.ts    # Phase B: store → callbacks/events
│   ├── repackager.ts         # Collect failed requests → new batch
│   └── index.ts
packages/core/test/
└── engine/
    ├── result-ingester.test.ts
    ├── delivery-worker.test.ts
    └── repackager.test.ts
```

## Implementation notes

- **Result Ingester (Phase A):**
  - Called when a batch reaches terminal status (`ended`).
  - Calls `provider.fetchResults(ref)` which returns `AsyncIterable<NorushResult>`. The ingester `for await`s over it, persisting each result as it arrives.
  - **Claude:** yields results early as individual requests within the batch complete — true streaming. The ingester persists and delivers results before the full batch is done.
  - **OpenAI:** the adapter streams the output file line-by-line internally (task 1-05), but all results arrive only after the batch completes. The ingester uses the same iteration pattern; results just arrive in bulk after a delay.
  - For each result: `store.createResult()` immediately. Update corresponding request status (`succeeded` or `failed`).
  - Crash safety: if process dies mid-ingestion, already-persisted results survive. On restart, `request_id` UNIQUE constraint on `results` prevents duplicates.

- **Delivery Worker (Phase B):**
  - Runs on interval (or via `tick()`).
  - Reads `store.getUndeliveredResults(limit)`.
  - For each: invoke registered callback function and/or emit event.
  - On success: `store.markDelivered(id)`.
  - On failure: increment `delivery_attempts`, compute `next_delivery_at` with exponential backoff, store error message.
  - At `max_delivery_attempts` (default 5): `delivery_status` → `failed`.
  - Webhook delivery (Phase 3) will plug into this same loop later.

- **Repackager:**
  - After ingestion completes for a batch, scan its requests for `status: 'failed'` or `status: 'expired'`.
  - If `retry_count < max_provider_retries` (from batch config), increment `retry_count`, set `status: 'queued'`.
  - These re-queued requests will be picked up by the Batch Manager (task 1-06) on the next flush.
  - Requests exceeding budget → `status: 'failed_final'`.

- **Telemetry:** Emit `results_ingested`, `deliveries_attempted`, `delivery_failures` counters.

### Dependencies

- Requires task 1-02 (types, telemetry).
- Requires task 1-03 (Store for result persistence).
- Requires task 1-05 (Provider adapters for fetchResults).
- Requires task 1-06 (Batch Manager for repackaged requests).
- Requires task 1-07 (Status Tracker triggers ingestion on batch completion).

## Acceptance criteria

- Ingester persists results one at a time as they stream from the provider.
- Duplicate results (same `request_id`) are handled gracefully (idempotent).
- Delivery worker reads undelivered results and invokes callbacks.
- Delivery retries use exponential backoff with correct intervals.
- Delivery failures after max attempts mark result as `failed`.
- Repackager re-queues eligible failed/expired requests with incremented `retry_count`.
- Requests exceeding retry budget transition to `failed_final`.
- Unit tests cover: successful ingestion, partial ingestion crash recovery, delivery success/failure/retry, repackaging logic, retry budget exhaustion.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all result router tests.
- Trace through a full cycle: batch ends → ingest → deliver → callback invoked.
- Trace through a failure cycle: batch ends → ingest → some requests failed → repackage → re-queued.

## Review plan

- Verify two-phase separation: ingestion writes to store before delivery starts.
- Verify backoff formula matches PLAN.md Section 6.5 (10s → 20s → 40s → ... cap 10min).
- Verify repackaging respects `max_provider_retries` from batch record.
- Check crash-safety: partial ingestion + restart should not lose or duplicate results.
