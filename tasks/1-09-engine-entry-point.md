# Wire Up createNorush() Entry Point and Integration Tests

## Why this task exists

All core components exist individually — this task wires them together into the public `createNorush()` API that consumers use.
It also validates the full lifecycle end-to-end with integration tests.

## Scope

**Included:**
- `createNorush(config)` factory function that assembles and returns the engine
- Public API surface: `enqueue()`, `flush()`, `tick()`, `start()`, `stop()`, event subscription
- Worker entry point: `packages/core/src/worker.ts` — standalone process running the poll/delivery/repackaging loops
- End-to-end tests with MemoryStore (full lifecycle: enqueue → flush → submit → poll → ingest → deliver)
- Integration tests against real provider APIs (small batches, guarded by env vars)

**Out of scope:**
- Web application (Phase 2)
- REST API (Phase 3)
- npm publish (Phase 4)

## Context and references

- PLAN.md Section 3.4 (Library Configuration) — `createNorush()` config shape and example
- PLAN.md Section 7.3 (Docker: Two Entrypoints) — worker entrypoint at `packages/core/dist/worker.js`
- PLAN.md Section 7.6 (Worker Process) — single event loop with `setInterval` for each concern

## Target files or areas

```
packages/core/src/
├── norush.ts               # createNorush() factory
├── worker.ts               # Standalone worker entry point
└── index.ts                # Re-export createNorush and all public types
packages/core/test/
├── norush.test.ts          # End-to-end with MemoryStore
└── integration/
    └── providers.test.ts   # Real API calls (conditional on env vars)
```

## Implementation notes

- **`createNorush(config)`** should:
  1. Resolve config via `resolveConfig()`.
  2. Instantiate the store (or accept a pre-built store).
  3. Instantiate provider adapters from config.
  4. Create Request Queue, Batch Manager, Status Tracker, Result Router.
  5. Wire event flow: tracker completion → ingester → delivery → repackager.
  6. Return an object with: `enqueue()`, `flush()`, `tick()`, `start()`, `stop()`, `on(event, handler)`.

- **`start()`** kicks off `setInterval` loops for polling, delivery, and flush. **`stop()`** clears them. **`tick()`** runs one cycle of all loops (for serverless/cron use).

- **Worker entry point (`worker.ts`):**
  - Reads config from environment variables.
  - Calls `createNorush()` with `PostgresStore`.
  - Calls `start()`.
  - Handles `SIGTERM`/`SIGINT` → `stop()` for graceful shutdown.
  - This is the process that Azure Container Apps runs as the worker container.

- **End-to-end test with MemoryStore:**
  - Create engine with MemoryStore and mock providers.
  - Enqueue several requests to different providers/models.
  - Flush → verify batches created and submitted.
  - Mock provider returning completed status → tick → verify results ingested.
  - Verify delivery callbacks invoked with correct results.
  - Test failure path: mock provider returning errors → verify repackaging.

- **Integration tests (conditional):**
  - Only run when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars are set.
  - Submit a tiny batch (1-2 requests) to each provider.
  - Poll until completion.
  - Verify results are received and correctly parsed.
  - Use cheap models and short prompts to minimize cost.

### Dependencies

- Requires all previous Phase 1 tasks (1-01 through 1-08).

## Acceptance criteria

- `createNorush(config)` returns a working engine instance.
- `enqueue()` → `flush()` → `tick()` cycle processes requests end-to-end.
- `start()` and `stop()` manage interval loops correctly.
- Event handlers receive lifecycle events (`batch:completed`, etc.).
- Worker process starts, runs, and shuts down gracefully on SIGTERM.
- End-to-end test with MemoryStore covers the happy path and failure/repackaging path.
- Integration tests (when env vars present) successfully submit and retrieve from real providers.
- All public types and functions are exported from `@norush/core`.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all unit and e2e tests.
- `ANTHROPIC_API_KEY=... OPENAI_API_KEY=... pnpm test` also passes integration tests.
- `node packages/core/dist/worker.js` starts without errors (and shuts down on Ctrl+C).
- Verify exports: `import { createNorush, PostgresStore, MemoryStore } from '@norush/core'` resolves.

## Review plan

- Verify `createNorush` config shape matches PLAN.md Section 3.4.
- Verify worker handles graceful shutdown.
- Check that integration tests are properly gated behind env vars (not run in CI without keys).
- Confirm the full lifecycle is tested: enqueue → batch → submit → poll → ingest → deliver.
