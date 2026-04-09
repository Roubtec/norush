# Implement Status Tracker with Orphan Recovery and Circuit Breaker

## Why this task exists

Batches submitted to providers need continuous monitoring — polling for completion, detecting failures, recovering orphans from crashed processes, and stopping submission cascades via a circuit breaker.
The Status Tracker is the control loop that drives the batch lifecycle after submission.

## Scope

**Included:**
- **Poll loop:** Periodically check all in-flight batches via provider adapters, using the assigned polling strategy
- **Status transitions:** Map provider status to internal batch status, update store
- **Orphan recovery:** Detect and re-submit pending batches with no `provider_batch_id` (crash recovery)
- **Circuit breaker:** Trip after N consecutive submission failures, cooldown, probe batch to recover
- **Partial batch failure detection:** Identify per-request outcomes within a completed batch
- Event emission: `batch:submitted`, `batch:processing`, `batch:completed`, `batch:expired`, `batch:error`, `circuit_breaker:tripped`
- Unit tests with mocked providers and MemoryStore

**Out of scope:**
- Result ingestion and delivery (task 1-08 — Result Router)
- Automatic repackaging of failed requests (task 1-08)
- Spend limits and rate limiting (Phase 3)

## Context and references

- PLAN.md Section 3.2 (Components) — Status Tracker description
- PLAN.md Section 6.1 (Write-Before-Submit & Orphan Recovery) — orphan detection criteria, attempt caps
- PLAN.md Section 6.4 (Guardrails) — `max_submission_attempts`, `max_provider_retries`, circuit breaker threshold/cooldown
- PLAN.md Section 6.3 (Adaptive Batch Polling) — strategy assignment, per-batch overrides

## Target files or areas

```
packages/core/src/
├── engine/
│   ├── status-tracker.ts     # Poll loop, status transitions
│   ├── orphan-recovery.ts    # Orphan detection and re-submission
│   ├── circuit-breaker.ts    # Circuit breaker state machine
│   └── index.ts
packages/core/test/
└── engine/
    ├── status-tracker.test.ts
    ├── orphan-recovery.test.ts
    └── circuit-breaker.test.ts
```

## Implementation notes

- **Poll loop:** Can run as `setInterval` (long-running process) or be driven externally via `tracker.tick()` (serverless/cron). Each tick:
  1. Get in-flight batches from store (`store.getInFlightBatches()`).
  2. For each batch, check if it's time to poll (using the batch's polling strategy and `PollContext`).
  3. Call `provider.checkStatus(ref)` for due batches.
  4. Update batch status in store based on provider response.
  5. On terminal status (`ended`, `expired`, `failed`), mark for result processing.

- **Orphan recovery** (runs each tick):
  - Query: `status = 'pending'`, `provider_batch_id IS NULL`, `updated_at < NOW() - 5 min`, `submission_attempts < max_submission_attempts`.
  - Increment `submission_attempts`, re-call provider `submitBatch()`.
  - At `max_submission_attempts` (default 3), transition to `status: 'failed'`.
  - Log `orphan_recovered` event.

- **Circuit breaker:**
  - State machine: `closed` → `open` → `half_open` → `closed`.
  - Trips when N consecutive batch submissions fail (default 5).
  - In `open` state: reject all new submissions, emit `circuit_breaker:tripped`.
  - After cooldown (default 10 min): transition to `half_open`, allow one probe batch.
  - If probe succeeds → `closed`. If probe fails → back to `open`, reset cooldown.

- **Event emission:** Use the `TelemetryHook` for metrics and an `EventEmitter` (or callback registry) for lifecycle events that consumers can subscribe to.

### Dependencies

- Requires task 1-02 (types, interfaces, polling strategy interface).
- Requires task 1-03 (Store for batch queries).
- Requires task 1-04 (Polling strategies for interval calculation).
- Requires task 1-05 (Provider adapters for status checks).
- Requires task 1-06 (Batch Manager for orphan re-submission).

## Acceptance criteria

- Poll loop checks in-flight batches at strategy-determined intervals.
- Provider status is correctly mapped to internal batch status.
- Orphan batches are detected and re-submitted with correct criteria.
- Orphans exceeding `max_submission_attempts` transition to `failed`.
- Circuit breaker trips after N consecutive failures and pauses submissions.
- Circuit breaker recovers via cooldown → probe → close cycle.
- Lifecycle events are emitted for all batch state transitions.
- `tracker.tick()` can be called externally for serverless use.
- Unit tests cover: normal polling cycle, orphan detection, orphan cap, circuit breaker trip/recover.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all status tracker, orphan recovery, and circuit breaker tests.
- Verify circuit breaker state machine transitions with explicit test scenarios.

## Review plan

- Verify orphan recovery criteria match PLAN.md Section 6.1 (5-minute grace, attempt cap).
- Verify circuit breaker thresholds match PLAN.md Section 6.4 defaults.
- Check that polling respects per-batch strategy override.
- Confirm `tick()` is a viable entry point for external callers.
