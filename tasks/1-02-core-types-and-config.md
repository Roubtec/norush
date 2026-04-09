# Define Core Types, Interfaces, and Config System

## Why this task exists

Every subsequent component (stores, adapters, engine) depends on shared type definitions and configuration resolution.
Defining these first establishes the contract that all modules implement against.

## Scope

**Included:**
- All core interfaces: `Provider`, `Store`, `PollingStrategy`, `TelemetryHook`, `HealthScore`
- All data types: `NorushRequest`, `NorushResult`, `Batch`, `NewRequest`, `NewBatch`, `NewResult`, `Request`, `Result`, `BatchStatus`, `ProviderBatchRef`, `PollContext`, `UsageStats`, `DateRange`
- Status enums/unions for requests, batches, results, and delivery
- Config types: environment, operator, user tiers
- `resolveConfig(env, operator, user)` function with clamping logic
- `NoopTelemetry` and `ConsoleTelemetry` implementations of `TelemetryHook`

**Out of scope:**
- Store implementations (next task)
- Provider adapter implementations (task 1-05)
- Polling strategy implementations (task 1-04)
- Engine/orchestration logic

## Context and references

- PLAN.md Section 3.3 (Core Interfaces) — `Provider`, `Store`, `PollingStrategy`, `TelemetryHook`, `HealthScore`
- PLAN.md Section 3.4 (Library Configuration) — `createNorush` config shape
- PLAN.md Section 6.7 (Three-Tier Configuration) — env → operator → user with clamping
- PLAN.md Section 6.7 (Telemetry) — metric categories, `NoopTelemetry`, `ConsoleTelemetry`
- PLAN.md Section 4.1 (Schema) — status values for requests, batches, results

## Target files or areas

```
packages/core/src/
├── types.ts              # All data types and status unions
├── interfaces/
│   ├── provider.ts       # Provider interface
│   ├── store.ts          # Store interface
│   ├── polling.ts        # PollingStrategy, PollContext
│   └── telemetry.ts      # TelemetryHook, HealthScore
├── config/
│   ├── types.ts          # Config tier types
│   └── resolve.ts        # resolveConfig() with clamping
├── telemetry/
│   ├── noop.ts           # NoopTelemetry
│   └── console.ts        # ConsoleTelemetry
└── index.ts              # public API re-exports
```

## Implementation notes

- Use ULID string type aliases (e.g., `type NorushId = string`) for clarity in interfaces but don't over-abstract.
- Status values should be string literal unions, not enums, for JSON compatibility.
- `resolveConfig` must enforce: user settings cannot exceed operator caps (e.g., retention clamped), operator cannot override env. See PLAN.md Section 6.7 for precedence rules.
- The `Store` interface should match Section 3.3 exactly — the next task implements it.
- `ConsoleTelemetry` should log to `console.log` with a `[norush]` prefix and include metric name, value, and tags.
- Export everything from `packages/core/src/index.ts` so consumers have a single import path.

## Acceptance criteria

- All interfaces from PLAN.md Section 3.3 are defined and exported.
- All request/batch/result status values are defined as string literal unions.
- `resolveConfig()` merges three tiers with correct precedence and clamping.
- `NoopTelemetry` implements `TelemetryHook` as a no-op.
- `ConsoleTelemetry` implements `TelemetryHook` with console output.
- Config resolution has unit tests covering: defaults, override precedence, clamping edge cases.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes with config resolution tests.
- `pnpm typecheck` passes — all interface references resolve correctly.
- Import from `@norush/core` in a test file and verify all expected types are available.

## Review plan

- Verify each interface matches PLAN.md Section 3.3 signatures.
- Verify status unions match PLAN.md Section 4.1 schema comments.
- Check `resolveConfig` clamping logic against PLAN.md Section 6.7 rules.
- Confirm telemetry implementations satisfy the interface contract.
