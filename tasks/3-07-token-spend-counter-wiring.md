# Wire Token and Spend Counters into Result Ingestion

## Why this task exists

`checkRateLimit()` enforces `maxTokensPerPeriod` and `hardSpendLimitUsd` by reading `currentPeriodTokens` and `currentSpendUsd` from the `user_limits` table.
However, nothing currently writes to those counters — there are no call sites for `store.incrementPeriodTokens()` or `store.incrementSpend()`.
As a result, token and spend limits are checked but never enforced in practice (the counters never increase).

This was flagged in PR #21 review (Copilot comment on `packages/core/src/rate-limit/limiter.ts:66`).

## Scope

**Included:**
- Hook `store.incrementPeriodTokens(userId, inputTokens + outputTokens)` into the result ingestion path (where results are persisted after a batch completes)
- Hook `store.incrementSpend(userId, amountUsd)` into the same path, computing USD spend from token counts using per-model pricing (or a configurable rate table)
- Handle the case where a request's `userId` must be looked up from the associated request record (results don't carry `userId` directly)
- Add integration tests verifying that token/spend counters increment after result ingestion

**Out of scope:**
- Retroactive backfill of counters for existing results
- Real-time per-request billing integration (future billing task)
- UI display of token/spend usage beyond what is already shown on the settings/limits page

## Context and references

- PR #21 review comment on `packages/core/src/rate-limit/limiter.ts:66`
- `Store.incrementPeriodTokens(userId, count)` and `Store.incrementSpend(userId, amountUsd)` are already defined in `packages/core/src/interfaces/store.ts` and implemented in both `PostgresStore` and `MemoryStore`
- Results carry `inputTokens` and `outputTokens` (nullable) — see `packages/core/src/types.ts`
- The result ingestion path is in the batch polling/result processor — find where `store.createResult()` is called and add counter updates there
- Pricing: a simple configurable map `{ provider: { model: { inputCostPerToken, outputCostPerToken } } }` is sufficient for now; exact values can come from PLAN.md or provider docs

## Acceptance criteria

- [ ] After a batch result is persisted, `currentPeriodTokens` increases by `inputTokens + outputTokens` for the request's user
- [ ] After a batch result is persisted, `currentSpendUsd` increases by the computed USD cost for the request's user
- [ ] Both increments are best-effort (failures are logged but do not fail result delivery)
- [ ] `MemoryStore` and `PostgresStore` counter methods are exercised in integration tests
- [ ] Token and spend limits trigger correctly in `checkRateLimit()` after a run of requests that exhausts them
