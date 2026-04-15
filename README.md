# norush

**Deferred LLM processing for people who can wait.**

norush is a batch-processing engine for LLM APIs that trades immediacy for
cost. Both Anthropic (Claude) and OpenAI offer asynchronous batch APIs at
**50% off** standard pricing — norush abstracts the complexity of using them.

## Why

Real-time LLM responses are expensive and often unnecessary. Many use cases
don't need answers in milliseconds:

- **Overnight summarization** — queue up news articles, research papers, or
  meeting notes before bed; wake up to summaries.
- **Bulk analysis** — process thousands of data points, reviews, or support
  tickets without babysitting API calls.
- **Thought dumping** — write down questions and ideas throughout the day;
  read thoughtful responses when you're ready.
- **Pipeline stages** — feed LLM outputs into downstream processes that run
  on their own schedule.

norush handles the full lifecycle: batching requests, submitting them to
providers, tracking progress, retrieving results, and routing them where
they need to go — all while persisting state so nothing gets lost.

## What

### Core Library (`@norush/core`)

A TypeScript library that manages deferred LLM request processing:

- **Multi-provider** — Anthropic Claude and OpenAI from a single interface.
  Submit to whichever provider/model you want per-request.
- **Automatic batching** — Queues requests and flushes them in optimal batch
  sizes on a configurable schedule.
- **Lifecycle management** — Tracks every request from submission through
  completion. Handles polling, retries on expiration, and crash recovery.
- **Persistence** — PostgreSQL-backed storage with configurable data retention
  policies. Every request-response pair is tracked.
- **Result routing** — Deliver results via callbacks, event emitters, or
  webhook POSTs with optional HMAC signing.
- **Broker model** — Delivers results to your webhooks. Chain further work
  by submitting new requests through the norush API.

### Deferred Chat (`norush.roubtec.com`)

A web application built on the core library:

- Users bring their own API keys (Anthropic, OpenAI).
- Chat interface designed for async conversation — write now, read later.
- Responses appear when ready (minutes to hours).
- Optional webhook forwarding — use norush as a batch-processing broker
  without self-hosting.

## How It Works

```txt
You write prompts
       │
       ▼
  norush queues them
       │
       ▼
  Batches are submitted to Claude / OpenAI batch APIs (50% cheaper)
       │
       ▼
  norush polls for completion
       │
       ▼
  Results arrive → delivered to your callback, webhook, or inbox
```

Underneath, norush maps to each provider's native batch API:

|                    | Anthropic (Claude) | OpenAI            |
| ------------------ | ------------------ | ----------------- |
| API                | Message Batches    | Batch API         |
| Discount           | 50%                | 50%               |
| Max batch          | 100K requests      | 50K requests      |
| Typical completion | <1 hour            | <24 hours         |
| Format             | JSON body          | JSONL file upload |

## Development

### Prerequisites

- **Node.js** ≥ 24
- **pnpm** 10.x (`npm install -g pnpm`)
- **Docker** (for the local PostgreSQL database)

### Install

```sh
pnpm install
```

### Workspace packages

| Package        | Description                   |
| -------------- | ----------------------------- |
| `@norush/core` | Core batch-processing library |
| `@norush/web`  | Deferred chat web application |

### Scripts

| Command          | Description                                  |
| ---------------- | -------------------------------------------- |
| `pnpm build`     | Compile all packages                         |
| `pnpm test`      | Run all tests (Vitest)                       |
| `pnpm lint`      | Lint all packages (ESLint)                   |
| `pnpm typecheck` | Type-check all packages (TypeScript strict)  |
| `pnpm dev:up`    | Build and start the full stack via Docker    |
| `pnpm dev:down`  | Stop and remove all compose services         |
| `pnpm db:up`     | Start local PostgreSQL 17 via Docker Compose |
| `pnpm db:down`   | Stop local PostgreSQL (preserves data)       |

### Local database

Start PostgreSQL with `pnpm db:up`.
The database is available at `localhost:5432` with database `norush` and password `dev`.

## Running with Docker

The project ships a multi-stage `Dockerfile` and a `docker-compose.yml` that runs the full stack (PostgreSQL, web server, and background worker).

```bash
# Start everything (builds on first run)
docker compose up --build

# Start in the background
docker compose up --build -d

# Stop (worker shuts down gracefully)
docker compose down
```

The web server is available at `http://localhost:3000`.
Provider API keys and other secrets can be set via environment variables or a `.env` file:

Copy [`.env.example`](./.env.example) to `.env` and fill in the values you need.
The most important ones for a first run:

```env
NORUSH_MASTER_KEY=your-secret-key
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Skip WorkOS login in development (NEVER set in production):
NORUSH_DEV_AUTH_BYPASS=1
```

### Development (without Docker)

```bash
# Start just the database
docker compose up -d postgres

# Install dependencies and build
pnpm install
pnpm build

# Run tests
pnpm test
```

## Deployment

norush deploys to Azure Container Apps via GitHub Actions.
On merge to `main`, the deploy workflow builds the Docker image, pushes it to Azure Container Registry, and updates both the web and worker containers.

See [infra/README.md](./infra/README.md) for full Azure setup instructions, including:

- Resource provisioning (Container Apps, PostgreSQL, ACR)
- GitHub repository secrets configuration
- Custom domain setup
- Rollback procedures

## Telemetry

norush ships four telemetry adapters:

| Adapter                  | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `NoopTelemetry`          | Default. Silently discards all metrics.                |
| `ConsoleTelemetry`       | Logs to stdout with `[norush]` prefix.                 |
| `PrometheusTelemetry`    | Maps to `prom-client` counters and histograms.         |
| `OpenTelemetryTelemetry` | Maps to `@opentelemetry/api` meters (OTLP-compatible). |

The web application exposes `GET /metrics` for Prometheus scraping.

## Documentation

- [Getting Started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [API Reference](./docs/api-reference.md)
- [Architecture](./docs/architecture.md)
- [Deployment](./docs/deployment.md)

## Examples

- [Webhook Consumer](./examples/webhook-consumer/) -- receive and verify webhook deliveries.
- [Cron Batch](./examples/cron-batch/) -- enqueue and tick via cron/serverless.
- [GitHub Actions](./examples/github-action/) -- scheduled and manual workflows.

## Project Status

**Early development.** See [PLAN.md](./PLAN.md) for the full design document
and implementation roadmap.

## License

TBD
