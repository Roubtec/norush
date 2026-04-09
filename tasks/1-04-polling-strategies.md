# Implement Polling Strategies

## Why this task exists

The Status Tracker (task 1-07) needs pluggable polling strategies to decide how often to check batch status.
Building these as standalone, tested units makes the tracker simpler and strategies independently verifiable.

## Scope

**Included:**
- `PollingStrategy` implementations for all 4 presets: `linear`, `backoff`, `deadline-aware`, `eager`
- Interval clamping: minimum 10 seconds, maximum 15 minutes (enforced regardless of strategy)
- Strategy registry/factory: resolve a preset name to an implementation
- Per-batch strategy override (accept strategy name or custom function)
- Unit tests for each preset and clamping behavior

**Out of scope:**
- The poll loop itself (task 1-07 — Status Tracker)
- Integration with provider APIs

## Context and references

- PLAN.md Section 6.3 (Adaptive Batch Polling) — preset table, clamping rules, assignment model
- PLAN.md Section 3.3 — `PollingStrategy` and `PollContext` interfaces (defined in task 1-02)

## Target files or areas

```
packages/core/src/
├── polling/
│   ├── strategies.ts       # All 4 preset implementations
│   ├── clamp.ts            # Clamping utility (10s min, 15min max)
│   └── index.ts            # Factory/registry + re-exports
packages/core/test/
└── polling/
    └── strategies.test.ts
```

## Implementation notes

- **linear:** Fixed interval (default 60s). `nextInterval()` always returns the configured interval.
- **backoff:** Exponential: starts at 30s, doubles each poll, capped at 10min. Formula: `min(30_000 * 2^pollCount, 600_000)`.
- **deadline-aware:** Slow early (e.g., 5min intervals), accelerates as `expiresAt` approaches. Suggested: use remaining time percentage to scale between max and min intervals.
- **eager:** 15s for the first 5 minutes after submission, then falls back to `backoff` behavior.
- **Clamping** is applied as a wrapper/post-processing step, not inside each strategy. This keeps strategies pure and clamping testable independently.
- All strategies are pure functions of `PollContext` — no side effects, no state mutation.

### Dependencies

- Requires task 1-02 (PollingStrategy and PollContext interfaces).

## Acceptance criteria

- All 4 presets are implemented and exported.
- Clamping enforces 10s floor and 15min ceiling on any returned interval.
- Each strategy returns correct intervals for representative `PollContext` inputs.
- `deadline-aware` accelerates as `expiresAt` approaches.
- `eager` transitions from 15s to backoff behavior after 5 minutes.
- A strategy can be resolved by name string (e.g., `getStrategy('backoff')`).
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all polling strategy tests.
- Test cases cover: initial poll, mid-lifecycle poll, near-deadline poll, clamping at both bounds.

## Review plan

- Verify each preset matches PLAN.md Section 6.3 behavior table.
- Verify clamping is applied consistently (not possible to bypass).
- Check that strategies are pure functions with no hidden state.
