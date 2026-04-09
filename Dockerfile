# ============================================================================
# norush — multi-stage Docker build
# ============================================================================
# Produces a single image that can run as either the web server (default)
# or the background worker (via command override).
#
# Build:
#   docker build -t norush .
#
# Run web server:
#   docker run -p 3000:3000 norush
#
# Run worker:
#   docker run norush node packages/core/dist/worker.js
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — base: install pnpm and copy manifests
# ---------------------------------------------------------------------------
FROM node:24-slim AS base

WORKDIR /app

# Copy package.json first so corepack can activate the exact pnpm version
# pinned by the repository via the packageManager field.
COPY package.json ./

# Enable pnpm via corepack (ships with Node 24) using the repo-pinned version.
RUN corepack enable && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate

# Copy only the files pnpm needs to resolve the workspace and install deps.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/web/package.json packages/web/package.json

# Install all dependencies (including devDependencies needed for the build).
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2 — build: compile TypeScript and SvelteKit
# ---------------------------------------------------------------------------
FROM base AS build

# Copy source code (respects .dockerignore).
COPY tsconfig.json ./
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/web/src packages/web/src
COPY packages/web/tsconfig.json packages/web/tsconfig.json
COPY packages/web/svelte.config.js packages/web/svelte.config.js
COPY packages/web/vite.config.ts packages/web/vite.config.ts

# Build core first (web depends on it), then web.
RUN pnpm --filter @norush/core run build && \
    pnpm --filter @norush/web run build

# Prune devDependencies so only production deps remain.
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# Stage 3 — runtime: minimal image with built artefacts
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

# Run as non-root for security.
RUN groupadd --system norush && \
    useradd --system --gid norush --create-home norush

WORKDIR /app

# Copy monorepo root manifests (needed for pnpm workspace resolution).
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./

# Copy production node_modules (pruned in build stage).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/web/node_modules ./packages/web/node_modules

# Copy built artefacts.
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/web/build ./packages/web/build
COPY --from=build /app/packages/web/package.json ./packages/web/package.json

# Copy SQL migrations — read at runtime by migrate.ts via import.meta.url.
COPY packages/core/migrations ./packages/core/migrations

USER norush

# SvelteKit Node adapter defaults to port 3000.
ENV PORT=3000
EXPOSE 3000

# Default entrypoint: SvelteKit web server.
CMD ["node", "packages/web/build/index.js"]
