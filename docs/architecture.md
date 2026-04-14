# Architecture

norush is a deferred LLM batch execution engine.
It manages the full lifecycle of batch API requests across multiple providers.

## System Overview

```txt
  Client (API / Chat UI)
         |
         v
    +---------+
    |  Queue   |  Buffers requests, flushes into batches
    +---------+
         |
         v
  +-------------+
  |  BatchManager|  Submits batches to provider adapters
  +-------------+
         |
    +----+----+
    |         |
    v         v
 Claude    OpenAI       (Provider adapters)
 Adapter   Adapter
    |         |
    +----+----+
         |
         v
  +--------------+
  | StatusTracker |  Polls batch status on intervals
  +--------------+
         |
         v  (batch:completed)
  +---------------+
  | ResultIngester |  Fetches results from provider, persists in store
  +---------------+
         |
         v
  +----------------+
  | DeliveryWorker  |  Delivers results to callbacks / webhooks
  +----------------+
         |
         v
  +-------------+
  |  Repackager  |  Re-queues failed / expired requests
  +-------------+
         |
         v
  +-----------------+
  | RetentionWorker  |  Scrubs expired data per retention policies
  +-----------------+
```

## Core Components

### RequestQueue

Buffers incoming requests and flushes them into batches when thresholds are met:

- Maximum request count reached.
- Maximum byte size reached.
- Flush interval timer fires.

The queue is crash-safe: all enqueued requests are persisted before acknowledgment.

### BatchManager

Groups queued requests by provider and submits them as batches.
Respects per-provider limits (e.g. 100K requests for Claude, 50K for OpenAI).
Uses the `KeyResolver` interface for multi-tenant key selection.

### StatusTracker

Runs a polling loop that checks batch statuses and emits lifecycle events:

- `batch:submitted` -> `batch:processing` -> `batch:completed`
- `batch:expired` (timed out)
- `batch:failed` (permanent failure)

The tracker integrates a **CircuitBreaker** that stops polling a provider after consecutive failures and resumes after a cooldown.

### ResultIngester

Listens for `batch:completed` events, fetches results from the provider using the adapter's `fetchResults()` async generator, and persists each result in the store.
Updates token counters and spend tracking for rate limiting.

### DeliveryWorker

Delivers completed results to registered callbacks and webhook URLs.
Implements exponential backoff with jitter for webhook delivery retries.
After `maxDeliveryAttempts` failures, emits `delivery:exhausted`.

### Repackager

Handles failed and expired requests by re-queuing them with an incremented `retryCount`.
Respects the configured `maxRetries` limit.

### RetentionWorker

Periodically sweeps the store for data older than the configured retention policy.
Supports per-user policies (clamped to the operator hard cap).

### CircuitBreaker

Protects against cascading provider failures.
Tracks consecutive failures per provider and enters three states:

- **Closed** (normal): all requests flow through.
- **Open** (tripped): requests are rejected.
- **Half-open** (recovery): a single probe request is allowed.

### OrphanRecovery

Recovers batches stuck in intermediate states (e.g. `submitted` but never polled).
Runs on startup or periodically to handle process crashes.

## Provider Adapters

Each provider adapter implements the `Provider` interface:

| Adapter              | Provider  | Mechanism                                        |
|----------------------|-----------|--------------------------------------------------|
| `ClaudeAdapter`      | Anthropic | JSON body submission via Message Batches API     |
| `OpenAIBatchAdapter` | OpenAI    | JSONL file upload via Batch API                  |
| `OpenAIFlexAdapter`  | OpenAI    | Synchronous requests with `service_tier: "flex"` |

All adapters normalize their provider's status flow to norush's `BatchStatus` enum.

## Storage Layer

The `Store` interface abstracts persistence.
Two implementations are provided:

| Store           | Use case                                       |
|-----------------|------------------------------------------------|
| `MemoryStore`   | Testing and development. Data is lost on exit. |
| `PostgresStore` | Production. Crash-safe, survives restarts.     |

Both the web server and the worker process connect to the same PostgreSQL database.
They communicate exclusively through the database -- there is no inter-process messaging.

Schema migrations are managed by `migrate()` and run automatically on worker startup.

## Telemetry

All engine components instrument through the `TelemetryHook` interface.
Metrics are categorized as:

| Category | Metrics                                                                                  | Purpose           |
|----------|------------------------------------------------------------------------------------------|-------------------|
| Volume   | `requests_queued`, `batches_submitted`, `results_ingested`, `deliveries_attempted`       | Throughput        |
| Latency  | `batch_turnaround_ms`, `delivery_latency_ms`                                             | Performance       |
| Errors   | `submission_failures`, `delivery_failures`, `circuit_breaker_trips`, `orphan_recoveries` | Reliability       |
| Cost     | `input_tokens_total`, `output_tokens_total` (per-model, per-user)                        | Billing analytics |
| Size     | `batch_request_count`, `request_param_bytes`, `response_bytes`                           | Capacity planning |

Four adapters are available:

- **NoopTelemetry** -- discards everything (default).
- **ConsoleTelemetry** -- logs to stdout.
- **PrometheusTelemetry** -- maps to `prom-client` instruments.
- **OpenTelemetryTelemetry** -- maps to `@opentelemetry/api` meters.

## Configuration

Configuration follows a three-tier model (Environment > Operator > User).
See [Configuration](./configuration.md) for details.

The `resolveConfig()` function merges tiers with clamping so that user preferences never exceed operator caps.

## Deployment Architecture

In production, norush runs as two containers sharing a PostgreSQL database:

```txt
            Internet
               |
               v
    +------------------------+
    |  Azure Container Apps  |
    |    Environment         |
    |                        |
    |  +-------+  +------+   |
    |  |  web  |  |worker|   |
    |  | :3000 |  | (bg) |   |
    |  +---+---+  +--+---+   |
    |      |          |      |
    +------+----------+------+
           |          |
           v          v
    +------------------------+
    | PostgreSQL Flex Server |
    +------------------------+
```

- **Web container**: SvelteKit app serving the chat UI, API routes, and `/metrics` endpoint.
- **Worker container**: Long-running process that runs flush, poll, delivery, and retention loops.

Both containers use the same Docker image with different entrypoints.
See [Deployment](./deployment.md) for setup instructions.

## Security

- **API key encryption**: User-provided API keys are encrypted at rest using AES-256-GCM with keys derived from `NORUSH_MASTER_KEY` via HKDF.
- **Webhook signing**: Webhook payloads are signed with HMAC-SHA256 for verification by receivers.
- **Authentication**: The web application uses WorkOS AuthKit for user authentication.
- **Rate limiting**: Per-user request, token, and spend limits with sliding-window health scoring.
