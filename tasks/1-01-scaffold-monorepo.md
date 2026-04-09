# Scaffold pnpm Monorepo and Tooling

## Why this task exists

Everything else depends on a working monorepo with build, lint, test, and local database infrastructure.
This is the foundation task — no code can land without it.

## Scope

**Included:**
- pnpm workspace with `packages/core` (`@norush/core`) and `packages/web` (`@norush/web`)
- TypeScript configuration (strict, ESM, path aliases)
- Vitest setup (shared config, per-package test scripts)
- ESLint configuration
- Docker Compose for local PostgreSQL 17
- GitHub Actions CI workflow (lint + type-check + test on push/PR)
- Root `package.json` scripts: `build`, `test`, `lint`, `typecheck`, `db:up`, `db:down`

**Out of scope:**
- Application code, types, or business logic (next tasks)
- Production Docker image (Phase 2)
- Azure deployment (Phase 2)

## Context and references

- PLAN.md Section 7.1 (Stack Summary) — Node 24, TypeScript, pnpm workspaces, Vitest
- PLAN.md Section 7.4 (PostgreSQL Client) — `postgres.js` (Porsager)
- PLAN.md Section 7.7 (CI/CD) — GitHub Actions: lint + type-check + test
- PLAN.md Section 4.2 (PostgreSQL Rationale) — PostgreSQL 17, Docker for local dev

## Target files or areas

```
norush/
├── package.json                    # root workspace config
├── pnpm-workspace.yaml
├── tsconfig.json                   # base TS config
├── vitest.config.ts                # shared Vitest config (or per-package)
├── eslint.config.js
├── docker-compose.yml              # PostgreSQL 17
├── .github/workflows/ci.yml
├── packages/
│   ├── core/
│   │   ├── package.json            # @norush/core
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts            # placeholder export
│   └── web/
│       ├── package.json            # @norush/web
│       ├── tsconfig.json
│       └── src/
│           └── (empty, SvelteKit scaffold is Phase 2)
```

## Implementation notes

- Use `"type": "module"` in all `package.json` files (ESM throughout).
- Node 24 as the engine target. Set `"engines": { "node": ">=24" }`.
- `postgres.js` should be a dependency of `@norush/core` now — it will be needed immediately by the database layer task.
- `ulidx` should also be added as a dependency of `@norush/core`.
- Docker Compose should expose PostgreSQL on port 5432 with database `norush` and password `dev` (matches PLAN.md Section 4.2).
- The `@norush/web` package can be a minimal placeholder for now — SvelteKit scaffolding happens in Phase 2.
- GitHub Actions should run on push and PR to `main`. Use Node 24 and pnpm. Include a PostgreSQL service container for CI tests.

## Acceptance criteria

- `pnpm install` succeeds from root with no errors.
- `pnpm build` compiles both packages (even if output is trivial).
- `pnpm test` runs Vitest and passes (even with zero tests).
- `pnpm lint` and `pnpm typecheck` pass.
- `docker compose up -d` starts PostgreSQL 17 and it accepts connections on `localhost:5432`.
- GitHub Actions workflow file is valid YAML and references correct scripts.
- Both packages resolve each other correctly via pnpm workspace protocol.

## Validation

- Run `pnpm install && pnpm build && pnpm test && pnpm lint && pnpm typecheck` — all pass.
- Run `docker compose up -d` and verify `psql -h localhost -U postgres -d norush -c 'SELECT 1'` succeeds (or equivalent via `postgres.js`).
- Inspect `.github/workflows/ci.yml` for correctness.

## Review plan

- Verify workspace topology: `pnpm ls --depth 0` shows both packages.
- Confirm ESM: no `require()` calls, `"type": "module"` in all package.json files.
- Confirm TS strict mode is enabled.
- Check that CI workflow includes PostgreSQL service container and runs all four check scripts.
