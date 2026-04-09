# Implement Migration Runner, Schema, and Store Adapters

## Why this task exists

The persistence layer is the backbone of norush's crash-safety guarantee.
Every component that reads or writes state depends on a working `Store` implementation.
This task delivers both `PostgresStore` (for real use) and `MemoryStore` (for fast tests).

## Scope

**Included:**
- Migration runner (~50 lines): reads `.sql` files, tracks applied migrations in `schema_migrations` table, applies in order inside a transaction
- Initial migration `001_initial_schema.sql` — full schema from PLAN.md Section 4.1
- `PostgresStore` implementing all `Store` interface methods using `postgres.js`
- `MemoryStore` implementing the same interface with in-memory data structures
- Unit tests for `MemoryStore` (no external deps)
- Integration tests for `PostgresStore` (against Docker PostgreSQL)

**Out of scope:**
- Retention scrubbing worker (Phase 4, runs periodically calling `scrubExpiredContent`)
- Data seeding or fixtures beyond what tests need

## Context and references

- PLAN.md Section 4.1 (PostgreSQL Schema) — full DDL for all tables and indexes
- PLAN.md Section 4.3 (Store Adapters) — `MemoryStore` and `PostgresStore` descriptions
- PLAN.md Section 4.4 (Schema Notes) — ULID keys, `content_scrubbed_at`, index strategy
- PLAN.md Section 7.4 (PostgreSQL Client & Migrations) — `postgres.js`, migration runner spec
- PLAN.md Section 3.3 (Core Interfaces) — `Store` interface (defined in task 1-02)

## Target files or areas

```
packages/core/
├── migrations/
│   └── 001_initial_schema.sql
├── src/
│   ├── store/
│   │   ├── postgres.ts           # PostgresStore
│   │   ├── memory.ts             # MemoryStore
│   │   └── migrate.ts            # Migration runner
│   └── index.ts                  # re-export stores
└── test/
    ├── store/
    │   ├── memory.test.ts
    │   ├── postgres.test.ts
    │   └── store-contract.test.ts  # shared test suite run against both
    └── helpers/
        └── db.ts                 # test database setup/teardown helpers
```

## Implementation notes

- **Migration runner:** Read `migrations/` directory, sort by filename, compare against `schema_migrations` table, apply missing ones in a transaction. The `schema_migrations` table should be auto-created if it doesn't exist. Callable programmatically: `await migrate(sql)`.
- **PostgresStore:** Use `postgres.js` tagged template queries exclusively (SQL injection is structurally impossible). Connection via `DATABASE_URL` env var.
- **MemoryStore:** Use `Map` or plain objects. Must pass the same contract tests as `PostgresStore`. Not crash-safe — document this.
- **Shared test suite:** Write a `store-contract.test.ts` that takes a `Store` factory and runs all CRUD operations. Instantiate it twice — once with `MemoryStore`, once with `PostgresStore` (conditionally, when DB is available).
- **ULID generation:** Use `ulidx` for all ID generation in store methods (or accept IDs from callers — match the `Store` interface from task 1-02).
- All timestamps should be `Date` objects in TypeScript, stored as `TIMESTAMPTZ` in PostgreSQL.

### Dependencies

- Requires task 1-01 (monorepo scaffold, Docker Compose for PostgreSQL).
- Requires task 1-02 (Store interface and data types).

## Acceptance criteria

- `001_initial_schema.sql` contains all tables, indexes, and constraints from PLAN.md Section 4.1.
- Migration runner creates `schema_migrations` table and applies migrations idempotently.
- `PostgresStore` passes all Store contract tests against Docker PostgreSQL.
- `MemoryStore` passes all Store contract tests.
- Both stores correctly handle: create, read, update for requests, batches, and results.
- `getQueuedRequests`, `getPendingBatches`, `getInFlightBatches`, `getUndeliveredResults` return correct subsets.
- `scrubExpiredContent` replaces content with tombstones and sets `content_scrubbed_at`.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all store tests (MemoryStore always, PostgresStore when DB is up).
- Run `docker compose up -d` then `pnpm test` — both store suites green.
- Manually verify migration applied: `psql -c '\dt'` shows all expected tables.

## Review plan

- Compare `001_initial_schema.sql` line-by-line against PLAN.md Section 4.1.
- Verify `PostgresStore` uses tagged template queries (no string concatenation in SQL).
- Verify `MemoryStore` mimics the same filtering/sorting behavior as SQL queries.
- Check that contract tests cover all `Store` interface methods.
