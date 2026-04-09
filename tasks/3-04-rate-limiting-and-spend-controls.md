# Implement Per-User Spend Limits and Adaptive Rate Limiting

## Why this task exists

Without spend controls, a runaway script or misconfigured client could burn through a user's API budget.
Adaptive rate limiting additionally protects users by throttling during failure cascades.

## Scope

**Included:**
- Per-user spend limits: `max_requests_per_hour`, `max_tokens_per_day`, `hard_spend_limit_usd`
- Limit enforcement at enqueue time: reject new requests when limits exceeded
- Queued requests held (not submitted) when limits exceeded mid-period
- Adaptive rate limiting with health scores: `effective_limit = base_limit * health_factor`
- `computeHealth()` function with sliding window
- 429 response headers: `Retry-After`, `X-Norush-Health`, `X-Norush-Effective-Limit`
- Minimum throughput guarantee: at least 1 request per period at `critical` health
- Settings UI or API for users to configure their own limits
- `user_limits` table CRUD operations

**Out of scope:**
- Billing integration (future)
- Admin override of user limits (operator-level controls exist via config)

## Context and references

- PLAN.md Section 6.4 (Rate Limiting, Spend Controls & Safety) — guardrail table, per-user limits, adaptive rate limiting
- PLAN.md Section 6.4 (Adaptive Rate Limiting with Health Scores) — formula, health computation, sliding window, 429 headers
- PLAN.md Section 4.1 (Schema) — `user_limits` table

## Target files or areas

```
packages/core/src/
├── rate-limit/
│   ├── health.ts             # computeHealth(window) → HealthScore
│   ├── limiter.ts            # Rate limit check at enqueue time
│   └── index.ts
packages/core/test/
└── rate-limit/
    ├── health.test.ts
    └── limiter.test.ts
packages/web/src/
└── routes/
    └── (app)/
        └── settings/
            └── limits/
                ├── +page.svelte      # Spend limit configuration UI
                └── +page.server.ts
```

## Implementation notes

- **Limit enforcement:** On `enqueue()`, check the user's current period counters against their configured limits. If any limit exceeded, reject with 429 and appropriate headers.
- **Period tracking:** `user_limits.current_period_requests` and `current_period_tokens` are incremented on enqueue. Reset at `period_reset_at` (rolling window).
- **Health score computation:** Exactly as specified in PLAN.md Section 6.4:
  - `successRate >= 0.9` → factor 1.0 (healthy)
  - `successRate >= 0.5` → factor 0.5 (partial_failures)
  - `successRate > 0` → factor 0.25 (mostly_failing)
  - `successRate = 0` → factor 0.1 (critical)
- **Sliding window:** Configurable (default 1 hour). Tracks batch outcomes over the window.
- **Effective limit:** `base_limit * health_factor`. At `critical`, the minimum is 1 request per period.
- **429 headers:**
  - `Retry-After`: seconds until the period resets or window slides.
  - `X-Norush-Health`: current health reason.
  - `X-Norush-Effective-Limit`: current computed limit.
- **Settings UI:** Users configure their own limits (within operator caps from `resolveConfig`). Fields: max requests/hour, max tokens/day, hard spend limit.

### Dependencies

- Requires task 1-02 (HealthScore type, config resolution with clamping).
- Requires task 1-03 (Store — `user_limits` table).
- Requires task 1-06 (Request Queue — enforce limits at enqueue).
- Requires task 3-01 (REST API — 429 responses on API endpoints).

## Acceptance criteria

- Enqueue rejects requests when user exceeds configured limits.
- `hard_spend_limit_usd` blocks all new requests when reached.
- Health score is computed correctly from the sliding window.
- Effective limit decreases as health degrades.
- At `critical` health, at least 1 request per period is allowed.
- 429 responses include all three custom headers.
- Period counters reset at the configured interval.
- Settings UI allows users to view and update their limits.
- Unit tests cover: all health score tiers, limit enforcement, period reset, minimum throughput.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Set a low request limit → submit requests until rejected → verify 429 with correct headers.
- Simulate failing batches → verify health degrades and effective limit decreases.
- Wait for period reset → verify new requests are accepted.
- Update limits via settings UI → verify new limits are enforced.

## Review plan

- Verify health score computation matches PLAN.md formula exactly.
- Verify minimum throughput guarantee at `critical` level.
- Verify 429 headers are present and accurate.
- Check that already-submitted batches are not cancelled when limits are hit (PLAN.md specifies this).
- Verify user limits respect operator caps via `resolveConfig` clamping.
