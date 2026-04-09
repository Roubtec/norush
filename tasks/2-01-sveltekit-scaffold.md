# Scaffold SvelteKit Web Application

## Why this task exists

Phase 2 begins the consumer-facing web app (norush.chat).
This task establishes the SvelteKit project inside the monorepo with Svelte 5, server-side rendering, and the connection to `@norush/core`.

## Scope

**Included:**
- SvelteKit project in `packages/web` using Svelte 5 (runes)
- Node adapter for SvelteKit (runs on Azure Container Apps, not static hosting)
- Integration with `@norush/core` as a workspace dependency
- Database connection setup: `PostgresStore` initialized in server hooks
- Basic layout shell: header, main content area, footer
- Health check endpoint (`GET /api/health`)
- Development scripts: `dev`, `build`, `preview`

**Out of scope:**
- Authentication (task 2-02)
- API key management (task 2-03)
- Chat UI (task 2-04)
- Docker image (task 2-05)

## Context and references

- PLAN.md Section 5.1 (norush.chat) — architecture overview, user flow
- PLAN.md Section 7.1 (Stack Summary) — SvelteKit (Svelte 5), Node adapter
- PLAN.md Section 7.3 (Docker) — web entrypoint at `packages/web/dist/server.js`

## Target files or areas

```
packages/web/
├── package.json
├── svelte.config.js
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── app.html
│   ├── app.css               # Global styles / CSS reset
│   ├── hooks.server.ts       # Server hooks: init PostgresStore, norush engine
│   ├── lib/
│   │   └── server/
│   │       └── norush.ts     # Singleton norush engine instance
│   ├── routes/
│   │   ├── +layout.svelte    # App shell
│   │   ├── +page.svelte      # Landing / redirect to chat
│   │   └── api/
│   │       └── health/
│   │           └── +server.ts  # GET /api/health
│   └── app.d.ts              # SvelteKit type declarations
```

## Implementation notes

- Use `@sveltejs/adapter-node` — the app runs as a Node.js server, not static files.
- Svelte 5 with runes (`$state`, `$derived`, `$effect`) — do not use Svelte 4 stores.
- `hooks.server.ts` should initialize the database connection and norush engine on first request (lazy singleton).
- The norush engine instance in `lib/server/norush.ts` should be importable by any server route.
- Health check should verify DB connectivity (simple `SELECT 1` query).
- Keep styling minimal for now — a clean, responsive layout shell is enough. Can use a CSS framework later if desired.
- `pnpm build` for web should produce output compatible with the Node adapter (dist directory).

### Dependencies

- Requires task 1-01 (monorepo scaffold — `@norush/web` workspace exists).
- Requires task 1-09 (`@norush/core` is usable as a library).

## Acceptance criteria

- `pnpm --filter @norush/web dev` starts the dev server.
- `pnpm --filter @norush/web build` produces a Node-compatible build.
- `GET /api/health` returns 200 when the database is reachable.
- The app shell renders (header, content area, footer).
- `@norush/core` is importable in server routes.
- `pnpm build` and `pnpm typecheck` pass across the full monorepo.

## Validation

- Start dev server and visit `/` — layout renders.
- `curl http://localhost:5173/api/health` returns 200.
- `pnpm build` succeeds for both packages.

## Review plan

- Verify Node adapter is configured (not static or auto adapter).
- Verify Svelte 5 runes are used (no `$:` reactive declarations).
- Check that server-side norush engine is a lazy singleton, not re-created per request.
- Confirm health endpoint actually queries the database.
