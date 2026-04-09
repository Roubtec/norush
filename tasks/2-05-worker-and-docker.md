# Build Docker Image and Worker Entrypoint

## Why this task exists

The norush deployment model uses a single Docker image with two entrypoints: web server and worker.
This task produces the production Docker image and ensures the worker process runs correctly alongside the web server.

## Scope

**Included:**
- Multi-stage Dockerfile: install deps → build → runtime
- Web entrypoint (default): SvelteKit Node server
- Worker entrypoint: `node packages/core/dist/worker.js` — polling, delivery, retention loops
- Docker Compose update: add web + worker services alongside PostgreSQL
- `.dockerignore` for clean builds
- Graceful shutdown handling in worker (SIGTERM/SIGINT)

**Out of scope:**
- Azure deployment (task 2-06)
- CI/CD Docker push (task 2-06)
- Retention scrubbing worker logic (Phase 4 — the worker runs it, but the scrub logic itself is Phase 4)

## Context and references

- PLAN.md Section 7.3 (Docker: Single Image, Two Entrypoints) — Dockerfile structure, container table
- PLAN.md Section 7.6 (Worker Process) — single event loop with `setInterval`
- PLAN.md Section 7.2 (Azure Container Apps) — web + worker containers share DATABASE_URL and NORUSH_MASTER_KEY

## Target files or areas

```
Dockerfile
.dockerignore
docker-compose.yml            # Update: add web and worker services
packages/core/src/worker.ts   # Already exists from 1-09, verify it works in container
```

## Implementation notes

- **Dockerfile:**
  ```
  FROM node:24-slim AS base
  # Install pnpm
  # Copy monorepo root: package.json, pnpm-workspace.yaml, pnpm-lock.yaml
  # Copy package.json files for both packages
  # pnpm install --frozen-lockfile
  # Copy source
  # pnpm build
  
  FROM node:24-slim AS runtime
  # Copy built output + production node_modules
  # Default entrypoint: node packages/web/dist/server.js (SvelteKit Node adapter output, configured in svelte.config.js)
  ```

- **Docker Compose** should define three services:
  - `db`: PostgreSQL 17 (already exists)
  - `web`: norush image, default entrypoint, ports 3000, depends on db
  - `worker`: norush image, command override to `node packages/core/dist/worker.js`, depends on db
  - Both web and worker share `DATABASE_URL` and `NORUSH_MASTER_KEY` env vars.

- **Worker process** (from task 1-09) should already handle SIGTERM. Verify it works when Docker sends stop signals (Docker sends SIGTERM, then SIGKILL after timeout).

- **.dockerignore:** Exclude `node_modules`, `.git`, `*.md` (except package manifests), test files, `.env`.

- Keep the image as small as possible: use `node:24-slim`, prune dev dependencies.

### Dependencies

- Requires task 2-01 (SvelteKit app builds).
- Requires task 1-09 (worker entry point exists).

## Acceptance criteria

- `docker build .` produces a working image.
- `docker compose up` starts PostgreSQL, web server, and worker.
- Web server serves the SvelteKit app on port 3000.
- Worker starts polling/delivery loops (visible in logs).
- Worker shuts down gracefully on `docker compose stop` (no orphaned connections).
- Image size is reasonable (under 500MB).
- `pnpm build` still works outside Docker.

## Validation

- `docker compose up -d && curl http://localhost:3000/api/health` returns 200.
- `docker compose logs worker` shows polling loop starting.
- `docker compose stop worker` → logs show graceful shutdown.
- `docker images norush` shows reasonable image size.

## Review plan

- Verify multi-stage build (no dev dependencies in runtime image).
- Verify `.dockerignore` excludes test files and docs.
- Verify both entrypoints work from the same image.
- Check that env vars are not baked into the image (passed at runtime).
