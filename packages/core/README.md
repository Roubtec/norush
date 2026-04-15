# @norush/core

Deferred LLM batch execution engine.
Trade immediacy for **50% cost savings** via Anthropic and OpenAI batch APIs.

## Install

```bash
npm install @norush/core
```

## Quick Start

```typescript
import { createNorush, MemoryStore } from '@norush/core';

const engine = createNorush({
  store: new MemoryStore(),
  providers: {
    claude: [{ apiKey: process.env.ANTHROPIC_API_KEY! }],
  },
});

// Enqueue a request for deferred processing
const request = await engine.enqueue({
  userId: 'user-1',
  provider: 'claude',
  model: 'claude-sonnet-4-5-20250929',
  params: {
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Summarize this article...' }],
  },
});

// Register a delivery callback to receive results
engine.addDeliveryCallback(async (result) => {
  console.log('Result received:', result);
});

// Start the engine (runs flush, poll, and deliver loops)
engine.start();

// When done, stop gracefully
await engine.stop();
```

## How It Works

norush queues your LLM requests and submits them to provider batch APIs on a configurable schedule.
It then polls for completion, retrieves results, and delivers them via callbacks or webhooks.

```
enqueue() -> queue -> batch submit -> poll -> result -> deliver
```

The engine manages the full lifecycle: batching, submission, polling, crash recovery, retries, and delivery.

## Supported Providers

| Provider           | Adapter              | Batch API       | Discount |
| ------------------ | -------------------- | --------------- | -------- |
| Anthropic (Claude) | `ClaudeAdapter`      | Message Batches | 50%      |
| OpenAI             | `OpenAIBatchAdapter` | Batch API       | 50%      |
| OpenAI (Flex)      | `OpenAIFlexAdapter`  | Flex Processing | 50%      |

## Storage

- **`MemoryStore`** -- In-memory store for development and testing.
- **`PostgresStore`** -- PostgreSQL-backed persistence for production.
  Use `migrate(sql)` to apply the required database schema.

```typescript
import { createNorush, PostgresStore, migrate } from '@norush/core';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
await migrate(sql);

const engine = createNorush({
  store: new PostgresStore(sql),
  providers: {
    claude: [{ apiKey: process.env.ANTHROPIC_API_KEY! }],
  },
});
```

## Engine Modes

### Long-running process

Use `engine.start()` and `engine.stop()` for servers and workers that run continuously.

### Serverless / cron

Use `engine.tick()` to run one cycle of flush + poll + deliver, suitable for cron jobs or serverless functions.

```typescript
// In a cron handler or serverless function
await engine.tick();
```

## API Overview

### Factory

- `createNorush(config)` -- Create an engine instance with the given configuration.

### Engine Methods

- `engine.enqueue(request)` -- Queue a request for deferred processing.
- `engine.flush()` -- Force-flush the queue, forming and submitting batches.
- `engine.tick()` -- Run one cycle of all loops (flush, poll, deliver).
- `engine.start()` -- Start all interval loops.
- `engine.stop()` -- Stop all interval loops with a final flush.
- `engine.on(event, handler)` -- Subscribe to engine events.
- `engine.off(event, handler)` -- Unsubscribe from engine events.
- `engine.addDeliveryCallback(cb)` -- Register a delivery callback.
- `engine.removeDeliveryCallback(cb)` -- Remove a delivery callback.

### Configuration

- `resolveConfig(env, operator, user)` -- Merge environment, operator, and user config layers.

### Key Management

- `deriveKey(masterKey)` -- Derive an encryption key from a master key.
- `encrypt(plaintext, key)` / `decrypt(blob, key)` -- Encrypt/decrypt API keys at rest.
- `selectKeys(candidates)` -- Select API keys with failover support.

### Webhooks

- `signWebhookPayload(payload, secret)` -- Sign a webhook payload with HMAC.
- `verifyWebhookSignature(payload, signature, secret)` -- Verify a webhook signature.
- `deliverWebhook(url, payload, options)` -- POST a signed webhook to a URL.

### Rate Limiting

- `checkRateLimit(limits, window)` -- Check if a request is within rate limits.
- `buildRateLimitHeaders(result)` -- Build standard rate-limit HTTP headers.

### Pricing

- `standardCost(model, tokens)` / `batchCost(model, tokens)` -- Calculate costs.
- `savings(model, tokens)` -- Calculate savings from batch processing.

### Telemetry

Built-in adapters: `NoopTelemetry` and `ConsoleTelemetry` (available from the main entry point).

Optional adapters for production use are available via subpath imports to avoid
pulling in their dependencies when you don't need them:

```typescript
// Prometheus — requires: npm install prom-client
import { PrometheusTelemetry } from '@norush/core/prometheus';

const telemetry = new PrometheusTelemetry();
const engine = createNorush({ store, providers, telemetry });

// Expose metrics at GET /metrics via telemetry.registry.metrics()
```

```typescript
// OpenTelemetry — requires: npm install @opentelemetry/api
import { OpenTelemetryTelemetry } from '@norush/core/opentelemetry';

const telemetry = new OpenTelemetryTelemetry();
const engine = createNorush({ store, providers, telemetry });
```

### CLI

The package ships a `norush-rotate-key` CLI for master key rotation:

```bash
npx norush-rotate-key --old-key <hex> --new-key <hex> [--dry-run]
```

Requires the `DATABASE_URL` environment variable.

## Documentation

For the full project documentation, architecture, and deployment guide, see the [norush repository](https://github.com/norush-ai/norush).

## License

MIT
