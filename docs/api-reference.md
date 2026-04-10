# API Reference

All public types and classes are exported from `@norush/core`.

```typescript
import { createNorush, MemoryStore, NoopTelemetry } from "@norush/core";
import type { TelemetryHook, Provider, Store } from "@norush/core";
```

## Engine

### `createNorush(config: NorushConfig): NorushEngine`

Factory function that assembles and returns the engine.
Wires together all components: RequestQueue, BatchManager, StatusTracker, ResultIngester, DeliveryWorker, Repackager, and RetentionWorker.

### `NorushEngine`

The public engine interface returned by `createNorush()`.

| Method | Description |
|--------|-------------|
| `enqueue(request: NewRequest): Promise<Request>` | Queue a request for deferred processing. |
| `flush(): Promise<void>` | Force-flush the queue, forming and submitting batches. |
| `tick(): Promise<void>` | Run one cycle of all loops (flush, poll, deliver, retention). For serverless/cron. |
| `start(): void` | Start all interval loops. For long-running processes. |
| `stop(): Promise<void>` | Stop all loops and perform a final flush. |
| `on(event, handler): void` | Register an event handler. |
| `off(event, handler): void` | Remove an event handler. |
| `addDeliveryCallback(cb): void` | Register a delivery callback. |
| `removeDeliveryCallback(cb): void` | Remove a delivery callback. |
| `config: ResolvedConfig` | The resolved configuration (read-only). |

### `NorushConfig`

Configuration object for `createNorush()`:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `store` | `Store` | Yes | Storage backend (MemoryStore or PostgresStore). |
| `providers` | `Map<string, Provider>` or `Record` | Yes | Provider adapters or key configs. |
| `batching` | `object` | No | Batching overrides (maxRequests, maxBytes, flushIntervalMs). |
| `polling` | `object` | No | Polling overrides (intervalMs, maxRetries). |
| `delivery` | `object` | No | Delivery overrides (tickIntervalMs, maxDeliveryAttempts, batchSize). |
| `retention` | `object` | No | Retention config (defaultPolicy, hardCapDays, intervalMs). |
| `circuitBreaker` | `object` | No | Circuit breaker config (threshold, cooldownMs). |
| `telemetry` | `TelemetryHook` | No | Telemetry adapter. Defaults to NoopTelemetry. |

## Data Types

### `NewRequest`

Submit a new request for deferred processing:

```typescript
interface NewRequest {
  provider: ProviderName;  // "claude" | "openai"
  model: string;
  params: Record<string, unknown>;
  userId?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  externalId?: string;
}
```

### `Request`

A persisted request with its full lifecycle state:

```typescript
interface Request {
  id: NorushId;
  externalId?: string;
  provider: ProviderName;
  model: string;
  params: Record<string, unknown>;
  status: RequestStatus;
  batchId?: string;
  userId?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### `RequestStatus`

```typescript
type RequestStatus =
  | "queued"      // Waiting to be batched
  | "batched"     // Assigned to a batch, not yet submitted
  | "processing"  // Batch submitted and in progress
  | "completed"   // Result received
  | "failed"      // Permanently failed
  | "expired"     // Batch expired, may be retried
  | "delivered"   // Result delivered to callback/webhook
  ;
```

### `BatchStatus`

```typescript
type BatchStatus =
  | "pending"     // Created, not yet submitted
  | "submitted"   // Sent to provider
  | "processing"  // Provider is processing
  | "completed"   // All results available
  | "failed"      // Provider reported failure
  | "expired"     // Timed out
  | "cancelled"   // Cancelled by user or system
  ;
```

### `NorushResult`

```typescript
interface NorushResult {
  requestId: string;
  response: Record<string, unknown>;
  success: boolean;
  error?: string;
}
```

## Interfaces

### `TelemetryHook`

All engine paths instrument through this interface:

```typescript
interface TelemetryHook {
  counter(name: string, value: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  event(name: string, data?: Record<string, unknown>): void;
}
```

### `Provider`

Adapter interface for LLM batch APIs:

```typescript
interface Provider {
  submitBatch(requests: Request[]): Promise<ProviderBatchRef>;
  checkStatus(ref: ProviderBatchRef): Promise<string>;
  fetchResults(ref: ProviderBatchRef): AsyncGenerator<NewResult>;
  cancelBatch(ref: ProviderBatchRef): Promise<void>;
}
```

### `Store`

Persistence interface (implemented by MemoryStore and PostgresStore):

```typescript
interface Store {
  createRequest(req: NewRequest): Promise<Request>;
  getRequest(id: string): Promise<Request | null>;
  updateRequest(id: string, updates: Partial<Request>): Promise<Request>;
  getQueuedRequests(limit: number): Promise<Request[]>;
  createBatch(batch: NewBatch): Promise<Batch>;
  getBatch(id: string): Promise<Batch | null>;
  updateBatch(id: string, updates: Partial<Batch>): Promise<Batch>;
  // ... additional methods for results, events, and user limits
}
```

### `PollingStrategy`

Controls how polling intervals change between checks:

```typescript
interface PollingStrategy {
  nextInterval(context: PollContext): number;
}
```

## Store Implementations

### `MemoryStore`

In-memory store for testing and development.
All data is lost on process exit.

```typescript
import { MemoryStore } from "@norush/core";
const store = new MemoryStore();
```

### `PostgresStore`

PostgreSQL-backed store for production use.
Requires a `postgres` (postgres.js) connection.

```typescript
import postgres from "postgres";
import { PostgresStore, migrate } from "@norush/core";

const sql = postgres(process.env.DATABASE_URL!);
await migrate(sql); // Run schema migrations
const store = new PostgresStore(sql);
```

### `migrate(sql): Promise<string[]>`

Run database schema migrations.
Returns the names of applied migrations.
Idempotent -- safe to call on every startup.

## Provider Adapters

### `ClaudeAdapter`

Anthropic Message Batches API adapter.

```typescript
import { ClaudeAdapter } from "@norush/core";
const adapter = new ClaudeAdapter({ apiKey: "sk-ant-..." });
```

### `OpenAIBatchAdapter`

OpenAI Batch API adapter (JSONL file upload).

```typescript
import { OpenAIBatchAdapter } from "@norush/core";
const adapter = new OpenAIBatchAdapter({ apiKey: "sk-..." });
```

### `OpenAIFlexAdapter`

OpenAI Flex Processing adapter (synchronous, batch pricing).

```typescript
import { OpenAIFlexAdapter } from "@norush/core";
const adapter = new OpenAIFlexAdapter({ apiKey: "sk-..." });
```

## Telemetry Adapters

### `NoopTelemetry`

Default adapter. Silently discards all metrics and events.

```typescript
import { NoopTelemetry } from "@norush/core";
const telemetry = new NoopTelemetry();
```

### `ConsoleTelemetry`

Logs all metrics and events to stdout with a `[norush]` prefix.

```typescript
import { ConsoleTelemetry } from "@norush/core";
const telemetry = new ConsoleTelemetry();
// Output: [norush] counter requests_queued=5 {provider=claude}
```

### `PrometheusTelemetry`

Maps counters and histograms to `prom-client` instruments.
Events are silently dropped (Prometheus has no event concept).

```typescript
import { PrometheusTelemetry } from "@norush/core";
import { Registry } from "prom-client";

// Use a dedicated registry (recommended)
const registry = new Registry();
const telemetry = new PrometheusTelemetry(registry);

// Or let the adapter create its own
const telemetry2 = new PrometheusTelemetry();
const registry2 = telemetry2.registry;

// Expose metrics at GET /metrics
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
});
```

**Note:** Prometheus requires all label names to be declared when a metric is first created.
Always use a consistent set of tag keys per metric name.

### `OpenTelemetryTelemetry`

Maps counters and histograms to `@opentelemetry/api` instruments.
Compatible with any OTLP backend (Datadog, Grafana, New Relic, etc.).

```typescript
import { OpenTelemetryTelemetry } from "@norush/core";

// Requires an OpenTelemetry SDK MeterProvider to be registered globally
const telemetry = new OpenTelemetryTelemetry("norush");
```

Events are logged as structured JSON lines for log collectors to capture.

## Polling Strategies

```typescript
import {
  LinearStrategy,
  BackoffStrategy,
  DeadlineAwareStrategy,
  EagerStrategy,
  getStrategy,
} from "@norush/core";

// Get a strategy by name
const strategy = getStrategy("backoff");

// Or instantiate directly
const eager = new EagerStrategy();
```

## Engine Components

These are exported for advanced use cases where you need to compose the engine yourself:

| Component | Description |
|-----------|-------------|
| `RequestQueue` | Buffers and flushes requests into batches. |
| `BatchManager` | Submits batches to provider adapters. |
| `StatusTracker` | Polls batch statuses and emits events. |
| `ResultIngester` | Fetches and persists results from completed batches. |
| `DeliveryWorker` | Delivers results to callbacks and webhooks. |
| `Repackager` | Re-queues failed/expired requests for retry. |
| `RetentionWorker` | Scrubs expired data according to retention policies. |
| `CircuitBreaker` | Protects against cascading provider failures. |
| `OrphanRecovery` | Recovers batches stuck in intermediate states. |

## Utility Functions

### Crypto Vault

```typescript
import { deriveKey, encrypt, decrypt, maskApiKey } from "@norush/core";

const key = await deriveKey("master-password");
const encrypted = await encrypt(key, "sk-ant-secret-key");
const decrypted = await decrypt(key, encrypted);
console.log(maskApiKey("sk-ant-secret-key")); // "sk-ant-***key"
```

### Webhooks

```typescript
import { signWebhookPayload, verifyWebhookSignature } from "@norush/core";

const signature = await signWebhookPayload(payload, secret);
const valid = await verifyWebhookSignature(payload, signature, secret);
```

### Rate Limiting

```typescript
import {
  checkRateLimit,
  buildRateLimitHeaders,
  computeHealth,
  computeEffectiveLimit,
} from "@norush/core";

const result = checkRateLimit(userLimits, window);
const headers = buildRateLimitHeaders(userLimits);
```

### Pricing

```typescript
import { standardCost, batchCost, pricingSavings, getRates } from "@norush/core";

const rates = getRates("claude", "claude-sonnet-4-6");
const standard = standardCost(rates, 1000, 500);
const batch = batchCost(rates, 1000, 500);
const saved = pricingSavings(rates, 1000, 500);
```

## Events

The engine emits events for lifecycle transitions:

| Event | Emitted when |
|-------|-------------|
| `batch:submitted` | A batch is submitted to the provider. |
| `batch:processing` | Provider confirms the batch is being processed. |
| `batch:completed` | All results are available. |
| `batch:expired` | The batch timed out. |
| `batch:error` | A provider error occurred. |
| `batch:failed` | The batch permanently failed. |
| `circuit_breaker:tripped` | The circuit breaker opened. |
| `delivery:success` | A result was successfully delivered. |
| `delivery:failure` | A delivery attempt failed. |
| `delivery:exhausted` | All delivery attempts exhausted. |

```typescript
engine.on("batch:completed", (data) => {
  console.log("Batch completed:", data.batchId);
});

engine.on("delivery:success", (data) => {
  console.log("Delivered:", data.requestId);
});
```
