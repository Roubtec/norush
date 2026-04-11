# Configuration

norush uses a three-tier configuration model.
Higher tiers override lower tiers, and user settings are clamped to operator caps.

## Three-Tier Model

```
Tier 1: Environment (env vars)
  Set by: infrastructure / deployment pipeline
  Immutable at runtime.
         |
         v  overrides defaults
Tier 2: Operator config (file or env)
  Set by: whoever deploys norush
  Sets caps, defaults, and feature flags.
         |
         v  overrides operator defaults (clamped to caps)
Tier 3: User settings (database)
  Set by: end users via UI or API
  Personal preferences within operator-defined limits.
```

### Precedence Rules

- User settings cannot exceed operator caps (e.g. 120d retention is clamped to the 90d operator cap).
- Operator config cannot override environment settings.
- Defaults cascade: user -> operator -> library default.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes (production) | -- | PostgreSQL connection string. |
| `NORUSH_MASTER_KEY` | Yes (production) | -- | Master encryption key for the API key vault. |
| `ANTHROPIC_API_KEY` | No | -- | Anthropic API key (enables Claude adapter). |
| `OPENAI_API_KEY` | No | -- | OpenAI API key (enables OpenAI adapter). |
| `WORKOS_API_KEY` | No | -- | WorkOS API key for authentication. |
| `WORKOS_CLIENT_ID` | No | -- | WorkOS client ID for authentication. |
| `NODE_ENV` | No | `development` | Node environment. |
| `ORIGIN` | No | -- | Public origin URL for CORS and redirects. |

### Worker-Specific Variables

These control the standalone worker entry point (`node packages/core/dist/worker.js`):

| Variable | Default | Description |
|----------|---------|-------------|
| `NORUSH_FLUSH_INTERVAL_MS` | `300000` (5 min) | How often the queue auto-flushes. |
| `NORUSH_POLL_INTERVAL_MS` | `60000` (1 min) | How often batch statuses are polled. |
| `NORUSH_DELIVERY_INTERVAL_MS` | `5000` (5 sec) | How often delivery checks run. |
| `NORUSH_MAX_REQUESTS` | `1000` | Maximum requests per flush. |
| `NORUSH_RETENTION_DEFAULT` | `7d` | Default data retention policy. |
| `NORUSH_RETENTION_HARD_CAP_DAYS` | `90` | Maximum retention days (operator cap). |
| `NORUSH_RETENTION_INTERVAL_MS` | `3600000` (1 hr) | How often retention sweeps run. |

## Programmatic Configuration

When using `createNorush()` directly, pass a `NorushConfig` object:

```typescript
import { createNorush, MemoryStore, ConsoleTelemetry } from "@norush/core";

const engine = createNorush({
  store: new MemoryStore(),
  providers: {
    claude: [{ apiKey: "sk-ant-..." }],
    openai: [{ apiKey: "sk-..." }],
  },
  batching: {
    maxRequests: 500,
    maxBytes: 50_000_000,
    flushIntervalMs: 120_000,
  },
  polling: {
    intervalMs: 30_000,
    maxRetries: 5,
  },
  delivery: {
    tickIntervalMs: 5_000,
    maxDeliveryAttempts: 5,
    batchSize: 50,
  },
  retention: {
    defaultPolicy: "7d",
    hardCapDays: 90,
    intervalMs: 3_600_000,
  },
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 60_000,
  },
  telemetry: new ConsoleTelemetry(),
});
```

## Batching Configuration

| Property | Default | Description |
|----------|---------|-------------|
| `maxRequests` | `1000` | Flush when queue reaches this many requests. |
| `maxBytes` | `100000000` (100 MB) | Flush when serialized size reaches this. |
| `flushIntervalMs` | `300000` (5 min) | Auto-flush interval. |

## Polling Configuration

| Property | Default | Description |
|----------|---------|-------------|
| `intervalMs` | `60000` (1 min) | Base polling interval. |
| `maxRetries` | `3` | Max retries for expired/failed batches. |

### Polling Strategies

norush supports multiple polling strategies that determine how the interval changes between polls:

| Strategy | Behavior |
|----------|----------|
| `linear` | Fixed interval (default). |
| `backoff` | Exponential backoff starting from the base interval. |
| `deadline` | Polls more aggressively as the batch approaches its deadline. |
| `eager` | Short initial interval, gradually increasing. |

## Retention Configuration

| Property | Default | Description |
|----------|---------|-------------|
| `defaultPolicy` | `7d` | Default retention period. Accepts `Nd` format (e.g. `30d`). |
| `hardCapDays` | `90` | Operator hard cap -- no user can exceed this. |
| `intervalMs` | `3600000` | How often the retention worker sweeps. |

## Circuit Breaker Configuration

| Property | Default | Description |
|----------|---------|-------------|
| `threshold` | `5` | Consecutive failures before the circuit opens. |
| `cooldownMs` | `60000` | Time to wait before attempting recovery (half-open state). |

## Telemetry Configuration

norush ships four telemetry adapters:

| Adapter | Package | Description |
|---------|---------|-------------|
| `NoopTelemetry` | `@norush/core` | Default. Silently discards all metrics. |
| `ConsoleTelemetry` | `@norush/core` | Logs metrics to stdout with `[norush]` prefix. |
| `PrometheusTelemetry` | `@norush/core` | Maps to `prom-client` counters and histograms. |
| `OpenTelemetryTelemetry` | `@norush/core` | Maps to `@opentelemetry/api` meters. |

See [API Reference](./api-reference.md) for usage details on each adapter.

## Provider Key Configuration

Each provider accepts an array of key configs for failover:

```typescript
providers: {
  claude: [
    { apiKey: "sk-ant-primary", label: "primary", priority: 0, failoverEnabled: true },
    { apiKey: "sk-ant-backup", label: "backup", priority: 1, failoverEnabled: true },
  ],
}
```

| Property | Default | Description |
|----------|---------|-------------|
| `apiKey` | -- | The provider API key (required). |
| `label` | -- | Human-readable label for logging. |
| `priority` | `0` | Lower values are preferred. |
| `failoverEnabled` | `true` | Whether this key participates in failover. |

## Config Resolution

Use `resolveConfig()` to merge tiers programmatically:

```typescript
import { resolveConfig } from "@norush/core";

const resolved = resolveConfig(
  { masterKey: process.env.NORUSH_MASTER_KEY },    // Tier 1: env
  { batching: { maxRequests: 500 } },               // Tier 2: operator
  { batching: { maxRequests: 200 } },               // Tier 3: user (clamped)
);

console.log(resolved.batching.maxRequests); // 200 (within operator cap)
```
