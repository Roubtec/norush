# Atomic Rate Limit Enforcement (Check + Consume)

## Why this task exists

The current rate limit flow in `POST /api/v1/requests` has a TOCTOU (time-of-check/time-of-use) race condition.
Multiple concurrent requests can all pass `checkRateLimit()` before any `incrementPeriodRequests()` call lands, allowing the limit to be exceeded under concurrent load.

This was flagged in the PR #21 review (Copilot comment on `+server.ts:193`).

## Scope

**Included:**
- Add an atomic "check and consume" store method that increments counters only if under limit, returning whether the check passed
- Replace the two-step `checkRateLimit()` + `incrementPeriodRequests()` pattern with the new atomic method
- Implement in `PostgresStore` using a single `UPDATE ... WHERE counter + count <= limit RETURNING *`
- Implement in `MemoryStore` with a synchronous in-memory check+increment (no real concurrency risk there)
- Add unit tests for concurrent-style scenarios

**Out of scope:**
- Distributed locking (the DB-level row lock in the UPDATE is sufficient)
- Retroactive cancellation of already-enqueued requests that slip through under a race (per PLAN.md, queued requests are never cancelled mid-period)

## Context and references

- PR #21 review comment on `packages/web/src/routes/api/v1/requests/+server.ts:193`
- Current two-step flow: `checkRateLimit()` in memory → `enqueue()` → `incrementPeriodRequests()` (fire-and-forget)
- PostgreSQL: use `UPDATE user_limits SET current_period_requests = current_period_requests + $count WHERE user_id = $uid AND current_period_requests + $count <= $effective_limit RETURNING current_period_requests`; if no row updated, the limit was exceeded
- The `hard_spend_limit_usd` check is cumulative and unchanged — it should remain a read-only check since spend is incremented asynchronously after results arrive

## Acceptance criteria

- [ ] `Store` interface has a new `consumePeriodRequests(userId, count, effectiveLimit): Promise<boolean>` (or equivalent) method
- [ ] `PostgresStore` implements it atomically
- [ ] `MemoryStore` implements it (non-atomic is fine since in-memory is single-threaded)
- [ ] Route handler uses the new atomic method instead of fire-and-forget increment
- [ ] Tests cover: request allowed (counter incremented), request rejected (counter not incremented), concurrent-safe behavior documented
