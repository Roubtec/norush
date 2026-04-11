# Getting Started

This guide walks you through installing norush, configuring a provider, and submitting your first batch.

## Prerequisites

- **Node.js** >= 24
- **pnpm** 10.x (`npm install -g pnpm`)
- An API key from [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/)

## Install

```bash
npm install @norush/core
# or
pnpm add @norush/core
```

## Quick Start (In-Memory)

The fastest way to try norush is with the in-memory store.
This requires no database and is suitable for development and testing.

```typescript
import {
  createNorush,
  MemoryStore,
  ConsoleTelemetry,
} from "@norush/core";

const engine = createNorush({
  store: new MemoryStore(),
  providers: {
    claude: [{ apiKey: process.env.ANTHROPIC_API_KEY! }],
  },
  telemetry: new ConsoleTelemetry(),
});

// Enqueue a request
const request = await engine.enqueue({
  provider: "claude",
  model: "claude-sonnet-4-6",
  params: {
    messages: [{ role: "user", content: "Summarise the benefits of batch processing." }],
    max_tokens: 1024,
  },
});

console.log("Queued request:", request.id);

// Flush queued requests into a batch and submit to the provider
await engine.flush();

// Run one poll cycle to check batch status and ingest results
await engine.tick();
```

## Quick Start (PostgreSQL)

For production use, norush persists state in PostgreSQL so that nothing is lost across restarts.

```typescript
import postgres from "postgres";
import {
  createNorush,
  PostgresStore,
  migrate,
  ConsoleTelemetry,
} from "@norush/core";

const sql = postgres(process.env.DATABASE_URL!);

// Run schema migrations (idempotent, safe to call on every startup)
await migrate(sql);

const store = new PostgresStore(sql);

const engine = createNorush({
  store,
  providers: {
    claude: [{ apiKey: process.env.ANTHROPIC_API_KEY! }],
    openai: [{ apiKey: process.env.OPENAI_API_KEY! }],
  },
  telemetry: new ConsoleTelemetry(),
});

// Start the engine loops (flush, poll, deliver) on intervals
engine.start();

// Enqueue work
await engine.enqueue({
  provider: "openai",
  model: "gpt-4o",
  params: {
    messages: [{ role: "user", content: "Explain batch APIs in one paragraph." }],
  },
});

// Later, gracefully shut down
process.on("SIGTERM", async () => {
  await engine.stop();
  await sql.end();
});
```

## Using the Standalone Worker

For long-running processes, use the built-in worker entry point instead of writing your own loop:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/norush \
ANTHROPIC_API_KEY=sk-ant-... \
node packages/core/dist/worker.js
```

The worker runs flush, poll, delivery, and retention loops on configurable intervals and handles graceful shutdown on SIGTERM/SIGINT.

## Using the Web Application

The `@norush/web` package is a SvelteKit application that provides:

- A chat interface for deferred conversations.
- REST API endpoints for programmatic batch submission.
- A dashboard showing usage and cost savings.

Start the full stack with Docker Compose:

```bash
docker compose up --build
```

The web server is available at `http://localhost:3000`.

## Next Steps

- [Configuration](./configuration.md) -- all configuration tiers and environment variables.
- [API Reference](./api-reference.md) -- public types, interfaces, and methods.
- [Architecture](./architecture.md) -- how the engine components fit together.
- [Deployment](./deployment.md) -- Docker, Azure, and self-hosted deployment guides.
