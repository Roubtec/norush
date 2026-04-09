# norush — Design & Implementation Plan

## 1. Overview

LLM APIs from Anthropic and OpenAI both offer **deferred/batch processing** at
**50% cost reduction**. These APIs are asynchronous: you submit requests, wait
(minutes to hours), then retrieve results. Today, every developer who wants to
use these APIs must build their own request batching, persistent tracking,
polling, result retrieval, error handling, retries, and multi-provider
abstraction.

**norush** eliminates this by providing a reusable deferred-execution engine
that handles the full lifecycle, and then building a consumer-facing product on
top of it.

**What makes this non-trivial:**

1. **Multi-provider abstraction** — One interface, multiple backends.
2. **Lifecycle management** — Automatic batching, polling, retry on expiry,
   result routing.
3. **Persistence by design** — Every request/response pair is tracked and
   recoverable. Crash-safe.
4. **Broker model** — Delivers results to webhooks, enabling chaining through
   norush's API.
5. **Multi-tenant key management** — Many users submit through one server,
   each with their own API keys.
6. **Scheduling** — Integration with cron or timer-based execution for
   environments that aren't always-on.

---

## 2. Provider API Reference

### 2.1 Anthropic Message Batches API

| Property | Value |
|----------|-------|
| Discount | **50%** off standard pricing |
| Max batch size | 100,000 requests or 256 MB |
| Completion window | Most <1h, hard limit 24h |
| Request format | JSON array of `{ custom_id, params }` |
| Status flow | `in_progress` → `ended` |
| Result retrieval | Poll GET endpoint or stream results via `results()` |
| Result availability | 29 days |
| Supported features | Vision, tool use, system messages, multi-turn, betas |
| Auth | `x-api-key` header |

Key details:
- Requests within a batch are **independent** (can mix models, features).
- Each request's `params` is identical to a standard Messages API call.
- `custom_id` ties request → response.
- Prompt caching with 1-hour TTL is recommended for shared context.

### 2.2 OpenAI Batch API

| Property | Value |
|----------|-------|
| Discount | **50%** off standard pricing |
| Max batch size | 50,000 requests or 200 MB |
| Completion window | 24h guaranteed |
| Request format | JSONL file upload via Files API |
| Status flow | `validating` → `in_progress` → `finalizing` → `completed` / `expired` / `cancelled` |
| Result retrieval | Download output file by `output_file_id` |
| Result availability | 30 days |
| Supported endpoints | `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/moderations`, `/v1/images/generations` |
| Auth | Bearer token |

Key details:
- **Two-step submission**: upload JSONL file first, then create batch
  referencing file ID.
- Output line order **may not match** input order — `custom_id` is essential.
- Separate error file for failed requests (`error_file_id`).
- Rate limits are in a separate pool from synchronous API.

### 2.3 OpenAI Flex Processing

| Property | Value |
|----------|-------|
| Discount | Batch-tier pricing (50%) |
| Mechanism | **Synchronous** — add `"service_tier": "flex"` to normal request |
| Latency | Slower, may return 429 if resources unavailable |
| Timeout | Recommend 15 min SDK timeout |

Flex is essentially "cheap synchronous" — not truly deferred. norush could
offer it as a fallback mode when the caller wants cheaper-but-still-realtime.

### 2.4 Comparison Matrix

| Feature | Claude Batches | OpenAI Batches | OpenAI Flex |
|---------|---------------|----------------|-------------|
| Async | Yes | Yes | No (sync, slow) |
| Discount | 50% | 50% | ~50% |
| Submission | JSON body | JSONL file upload | Inline param |
| Max requests | 100K | 50K | 1 per call |
| Completion SLA | ~1h typical, 24h max | 24h | Real-time (slow) |
| Custom ID | Yes | Yes | N/A |
| Cancellation | Yes | Yes | N/A |

---

## 3. Architecture

### 3.1 System Overview

```
┌─────────────────────────────────────────────────────┐
│                   Consumer Code                      │
│  (CLI tool, web app, webhook handler, cron job)      │
└──────────────────────┬──────────────────────────────┘
                       │
           ┌───────────▼───────────┐
           │    @norush/core       │
           │                       │
           │  ┌─────────────────┐  │
           │  │  Request Queue  │  │   ← accepts prompts, assigns IDs
           │  └────────┬────────┘  │
           │           │           │
           │  ┌────────▼────────┐  │
           │  │  Batch Manager  │  │   ← groups requests, submits batches
           │  └────────┬────────┘  │
           │           │           │
           │  ┌────────▼────────┐  │
           │  │    Providers    │  │   ← Claude adapter, OpenAI adapter
           │  │  (pluggable)    │  │
           │  └────────┬────────┘  │
           │           │           │
           │  ┌────────▼────────┐  │
           │  │  Status Tracker │  │   ← polls, handles expiry/retry
           │  └────────┬────────┘  │
           │           │           │
           │  ┌────────▼────────┐  │
           │  │  Result Router  │  │   ← callbacks, webhooks, storage
           │  └─────────────────┘  │
           │                       │
           │  ┌─────────────────┐  │
           │  │   Store (SPI)   │  │   ← persistence interface
           │  └─────────────────┘  │
           └───────────────────────┘
```

### 3.2 Components

**Request Queue** — Accepts individual prompt requests with metadata (provider,
model, priority, callback config). Assigns a ULID `norush_id` to each request.
Holds requests until a batch flush is triggered (by count threshold, byte
limit, time window, or manual flush).

**Batch Manager** — Groups queued requests by `(provider, model, api_key)`.
Serializes to the provider-specific format (JSON body for Claude, JSONL file
for OpenAI). Submits and records the provider's batch ID mapped to all
`norush_id`s within it.

**Provider Adapters:**
- `ClaudeAdapter` — Wraps Anthropic's Message Batches API.
- `OpenAIBatchAdapter` — Wraps OpenAI's Batch API (file upload + batch create).
- `OpenAIFlexAdapter` (Phase 4) — Wraps flex synchronous calls with
  retry/backoff.

**Status Tracker** — Runs a poll loop (configurable interval, default 60s)
that checks all in-flight batches. Emits events: `batch:submitted`,
`batch:processing`, `batch:completed`, `batch:expired`, `batch:error`. Handles
retries on expiry (re-queue requests into a new batch). Can be driven by an
internal `setInterval` (for long-running processes) or an external cron calling
`tracker.tick()` (for serverless environments).

**Result Router (Two-Phase Pipeline):**
- **Phase A — Ingestion:** Streams results from the provider one at a time,
  persists each to the store immediately. Crash-safe.
- **Phase B — Delivery:** Reads undelivered results from the store and fans
  them out: callback function (in-process), webhook POST (with optional
  HMAC-SHA256 signing), event emitter, or storage write.
- Delivery tracks attempts, supports retry with backoff, operates independently
  of ingestion. See Section 6.2.

**Store (SPI)** — Persistence interface. Built-in adapters:
- `MemoryStore` — For tests and ephemeral scripts. **Not crash-safe.**
- `PostgresStore` — For all persistent environments (dev, staging, prod).

### 3.3 Core Interfaces

```ts
// --- Provider adapter ---

interface Provider {
  submitBatch(requests: NorushRequest[]): Promise<ProviderBatchRef>
  checkStatus(ref: ProviderBatchRef): Promise<BatchStatus>
  fetchResults(ref: ProviderBatchRef): Promise<NorushResult[]>
  cancelBatch(ref: ProviderBatchRef): Promise<void>
}

// --- Persistence ---

interface Store {
  // Request lifecycle
  createRequest(req: NewRequest): Promise<Request>;
  getRequest(id: string): Promise<Request | null>;
  updateRequest(id: string, updates: Partial<Request>): Promise<void>;
  getQueuedRequests(limit: number): Promise<Request[]>;

  // Batch lifecycle
  createBatch(batch: NewBatch): Promise<Batch>;
  getBatch(id: string): Promise<Batch | null>;
  updateBatch(id: string, updates: Partial<Batch>): Promise<void>;
  getPendingBatches(): Promise<Batch[]>;
  getInFlightBatches(): Promise<Batch[]>;

  // Result lifecycle
  createResult(result: NewResult): Promise<Result>;
  getUndeliveredResults(limit: number): Promise<Result[]>;
  markDelivered(id: string): Promise<void>;

  // Retention
  scrubExpiredContent(before: Date): Promise<number>;

  // Telemetry / analytics
  getStats(userId: string, period: DateRange): Promise<UsageStats>;
}

// --- Polling ---

interface PollingStrategy {
  /** Return the delay (ms) before the next poll, given current state. */
  nextInterval(context: PollContext): number;
}

interface PollContext {
  batchId: string;
  provider: 'claude' | 'openai';
  submittedAt: Date;
  lastPolledAt: Date | null;
  pollCount: number;
  /** Provider's stated completion window (e.g., 24h). */
  expiresAt: Date;
}

// --- Telemetry ---

interface TelemetryHook {
  counter(name: string, value: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  event(name: string, data?: Record<string, unknown>): void;
}

// --- Rate limiting ---

interface HealthScore {
  /** Value between 0.1 and 1.0. */
  factor: number;
  /** What's driving the score. */
  reason: 'healthy' | 'partial_failures' | 'mostly_failing' | 'critical';
}
```

### 3.4 Library Configuration

```ts
const norush = createNorush({
  providers: {
    claude: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
  store: new PostgresStore(process.env.DATABASE_URL),
  batching: {
    maxRequests: 1000,       // flush when queue reaches this
    maxBytes: 50_000_000,    // flush at 50MB
    flushIntervalMs: 300_000, // auto-flush every 5 min
  },
  polling: {
    intervalMs: 60_000,      // check batch status every 60s
    maxRetries: 3,           // retry expired batches up to 3 times
  },
});
```

---

## 4. Data Model

### 4.1 PostgreSQL Schema

```sql
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,     -- ULID
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_api_keys (
  id                    TEXT PRIMARY KEY,     -- ULID
  user_id               TEXT NOT NULL REFERENCES users(id),
  provider              TEXT NOT NULL,        -- 'claude' | 'openai'
  label                 TEXT NOT NULL,        -- 'primary', 'backup', etc.
  api_key_encrypted     BYTEA NOT NULL,       -- AES-256-GCM encrypted
  priority              INTEGER NOT NULL DEFAULT 0,  -- lower = tried first
  failover_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_limits (
  user_id               TEXT PRIMARY KEY REFERENCES users(id),
  max_requests_per_hour INTEGER,              -- NULL = unlimited
  max_tokens_per_day    INTEGER,              -- NULL = unlimited
  hard_spend_limit_usd  NUMERIC(10,2),        -- NULL = unlimited
  current_period_requests INTEGER NOT NULL DEFAULT 0,
  current_period_tokens   INTEGER NOT NULL DEFAULT 0,
  period_reset_at       TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
  user_id               TEXT PRIMARY KEY REFERENCES users(id),
  retention_policy      TEXT NOT NULL DEFAULT '7d',
                        -- 'on_ack' | '1d' | '7d' | '30d' | custom e.g. '14d'
                        -- Default set by consuming app (7d for library, 30d for chat)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE requests (
  id                    TEXT PRIMARY KEY,     -- norush_id (ULID)
  external_id           TEXT,                 -- custom_id sent to provider
  provider              TEXT NOT NULL,        -- 'claude' | 'openai'
  model                 TEXT NOT NULL,        -- e.g. 'claude-sonnet-4-6'
  params                JSONB NOT NULL,       -- full request params
  status                TEXT NOT NULL DEFAULT 'queued',
                        -- queued | batched | processing | succeeded
                        -- | failed | expired | failed_final | canceled
  batch_id              TEXT,                 -- FK to batches.id (current batch)
  user_id               TEXT NOT NULL REFERENCES users(id),
  callback_url          TEXT,                 -- optional webhook for this request
  webhook_secret        TEXT,                 -- optional HMAC signing secret
  retry_count           INTEGER NOT NULL DEFAULT 0, -- times repackaged into new batch
  max_retries           INTEGER NOT NULL DEFAULT 5, -- per-request retry budget
  content_scrubbed_at   TIMESTAMPTZ,          -- NULL until scrubbed by retention worker
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE batches (
  id                    TEXT PRIMARY KEY,     -- internal batch ID (ULID)
  provider              TEXT NOT NULL,
  provider_batch_id     TEXT,                 -- ID from provider (NULL until confirmed)
  api_key_id            TEXT NOT NULL REFERENCES user_api_keys(id),
  api_key_label         TEXT,                 -- denormalized for auditing
  status                TEXT NOT NULL DEFAULT 'pending',
                        -- pending | submitted | processing | ended
                        -- | expired | cancelled | failed
  request_count         INTEGER NOT NULL DEFAULT 0,
  succeeded_count       INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,
  submission_attempts   INTEGER NOT NULL DEFAULT 0,  -- orphan recovery counter
  max_submission_attempts INTEGER NOT NULL DEFAULT 3,
  provider_retries      INTEGER NOT NULL DEFAULT 0,  -- provider-failure retries (free)
  max_provider_retries  INTEGER NOT NULL DEFAULT 5,
  polling_strategy      TEXT,                 -- override, NULL = global default
  submitted_at          TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE results (
  id                    TEXT PRIMARY KEY,     -- ULID
  request_id            TEXT NOT NULL UNIQUE REFERENCES requests(id),
  batch_id              TEXT NOT NULL REFERENCES batches(id),
  response              JSONB NOT NULL,       -- full provider response
  stop_reason           TEXT,                 -- end_turn, max_tokens, etc.
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  delivery_status       TEXT NOT NULL DEFAULT 'pending',
                        -- pending | delivered | failed | no_target
  delivery_attempts     INTEGER NOT NULL DEFAULT 0,
  max_delivery_attempts INTEGER NOT NULL DEFAULT 5,
  last_delivery_error   TEXT,
  next_delivery_at      TIMESTAMPTZ,          -- retry scheduling (backoff)
  delivered_at          TIMESTAMPTZ,
  content_scrubbed_at   TIMESTAMPTZ,          -- NULL until scrubbed
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_log (
  id                    TEXT PRIMARY KEY,     -- ULID
  entity_type           TEXT NOT NULL,        -- 'batch' | 'request' | 'result'
  entity_id             TEXT NOT NULL,
  event                 TEXT NOT NULL,        -- 'submitted', 'orphan_recovered',
                                              -- 'circuit_breaker_tripped', etc.
  details               JSONB,               -- scrubbed alongside parent record
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_user_id ON requests(user_id);
CREATE INDEX idx_requests_batch_id ON requests(batch_id);
CREATE INDEX idx_batches_status ON batches(status);
CREATE INDEX idx_batches_updated_at ON batches(updated_at);
CREATE INDEX idx_results_delivery_status ON results(delivery_status)
  WHERE delivery_status IN ('pending', 'failed');
CREATE INDEX idx_results_content_scrub ON results(content_scrubbed_at)
  WHERE content_scrubbed_at IS NULL;
CREATE INDEX idx_event_log_entity ON event_log(entity_type, entity_id);
```

### 4.2 PostgreSQL Rationale

PostgreSQL for all environments — local dev (Docker `postgres:17`), CI, and
cloud (Azure Database for PostgreSQL Flexible Server). No SQLite.

- **Full parity** — no dialect surprises when deploying.
- **JSONB** — binary JSON with indexing.
- **TIMESTAMPTZ** — UTC-normalized timestamps (stores UTC internally, converts
  on display based on session timezone; prevents ambiguous local-time bugs).
- **BOOLEAN** — native booleans instead of integer flags.
- **NUMERIC** — precise decimal for monetary values.
- **REFERENCES** — enforced foreign keys.
- **Partial indexes** — e.g., only index undelivered results.

Local dev setup:
```bash
docker run -d --name norush-db -p 5432:5432 \
  -e POSTGRES_DB=norush -e POSTGRES_PASSWORD=dev \
  postgres:17
```

### 4.3 Store Adapters

| Adapter | Use case | Notes |
|---------|----------|-------|
| `MemoryStore` | Unit tests; ephemeral scripts | No persistence; fastest; no external deps. **Not crash-safe** — if the process dies, in-flight state is lost. |
| `PostgresStore` | Dev, CI, staging, production | Uses `postgres.js` (Porsager); connection string via `DATABASE_URL` |

`MemoryStore` is first-class for: (1) tests that need fast, isolated,
deterministic storage without Docker, and (2) ephemeral scripts where a
developer batches a one-shot workload, waits for results in-process, and exits.
For any workload where losing in-flight requests matters, use `PostgresStore`.

### 4.4 Schema Notes

- All primary keys are ULIDs (time-sortable, B-tree friendly). See Section
  7.5.
- `content_scrubbed_at` on `requests` and `results` supports the retention
  worker (Section 6.6).
- Indexes target hot query paths: finding queued requests, pending batches,
  undelivered results, and records needing scrubbing.

---

## 5. Consumer Applications

### 5.1 norush.chat — Deferred Chat Web App

A web application where users log in, provide their own API keys, and use a
chat interface designed around **non-urgent conversations**.

**User flow:**
1. User signs up / logs in (WorkOS AuthKit).
2. User adds their Anthropic and/or OpenAI API keys (AES-256-GCM encrypted).
3. User writes messages — thoughts, questions, research requests — with no
   expectation of immediate response.
4. norush batches these and submits them using the user's API keys.
5. Responses arrive (minutes to hours later) and appear in the chat history.
6. User returns to read responses; can continue with follow-up messages.

**Key features:**
- "Thought dump" UX: write now, read later.
- Cost indicator showing savings vs real-time API usage.
- Notification when responses arrive (email, push, browser).
- Optional: forward responses to a webhook endpoint (broker mode).

**Architecture:**
```
Browser (SvelteKit)
    │
    ▼
API Server (SvelteKit server routes / Node.js)
    │
    ├── Auth (WorkOS AuthKit — social, passkeys, enterprise SSO)
    ├── Key vault (AES-256-GCM encrypted API key storage)
    ├── @norush/core (batch engine)
    ├── PostgresStore (local Docker / Azure Flexible Server)
    └── Worker (single event loop polling + delivery + retention)
```

### 5.2 Broker Mode

An extension of the chat app where users configure **webhook endpoints**.
norush acts as a batch-processing broker:

1. User submits prompts via UI or API.
2. norush batches and processes them.
3. On result arrival, norush POSTs responses to the user's configured endpoint.

This lets developers use norush as managed infrastructure without self-hosting
the batch lifecycle.

### 5.3 Developer Library

Developers `npm install @norush/core` and use it directly in their own apps,
scripts, or pipelines. Example: overnight news summarization, bulk content
generation, scheduled analysis jobs.

---

## 6. Design Decisions

### 6.1 Request & Batch Lifecycle

#### Multi-User Key Isolation

Separate batches per API key. A batch is always authenticated with exactly one
key. Even if two users use the same provider and model, their requests form
distinct batches because each user's key is the authentication boundary.

The Batch Manager groups requests by `(provider, model, api_key)`.

#### Write-Before-Submit Idempotency

**Submission protocol:**

1. **Before calling the provider API**, write a batch record to the store with
   `status: 'pending'` and `submission_attempts: 0`.
2. Increment `submission_attempts` to 1 and call the provider API.
3. On success, update with `provider_batch_id` and `status: 'submitted'`.
4. On failure, leave `provider_batch_id` as NULL — now an orphan candidate.

**Orphan recovery:** On each poll cycle, the Status Tracker scans for batches
where `status = 'pending'`, `provider_batch_id IS NULL`,
`updated_at < NOW() - 5 minutes`, and `submission_attempts < max`. These are
presumed orphans from a crashed process. The tracker increments
`submission_attempts` and re-submits. At `max_submission_attempts` (default 3),
the batch transitions to `status: 'failed'` and its requests become eligible
for user re-submission.

**Accepted trade-off:** Orphan recovery may cause double-submission if the
original process was slow (not crashed), resulting in double billing. We accept
this: better to pay twice and get results than pay once and lose them. The
grace period and attempt cap keep this bounded.

#### Partial Batch Failures & Repackaging

Each request within a batch has its own status:

| Request outcome | Action |
|----------------|--------|
| `succeeded` | Ingest result, queue for delivery |
| `errored` (provider error) | Mark `failed`, eligible for repackaging |
| `expired` (batch timed out) | Mark `expired`, eligible for repackaging |
| `canceled` (batch canceled) | Mark `canceled`, eligible for user re-trigger |

**Automatic repackaging:** Failed/expired requests where
`retry_count < max_provider_retries` are collected into a new batch. Their
`retry_count` is incremented. Requests exceeding the retry budget transition
to `status: 'failed_final'`.

**User-triggered re-submission:** Users can explicitly re-trigger any request
in a terminal state (`failed_final`, `canceled`, `expired_final`). This resets
`retry_count` to 0 and sets `status` back to `queued`. Not constrained by
retry budget (still constrained by spend limits).

### 6.2 Result Pipeline

#### Two-Phase Streaming

Decoupled ingestion from delivery for crash safety and independent retry.

**Phase A — Ingestion:** As provider results stream in (Claude SDK's
`results()` iterator, or line-by-line reading of OpenAI's output JSONL), each
result is immediately written to the `results` table. The batch does not need
to be fully complete before individual results are persisted.

**Phase B — Delivery:** A separate loop reads undelivered results from the
store and fans them out (callback, webhook, event emitter). Delivery is tracked
independently per result.

```
Provider API
    │
    │  stream results one by one
    ▼
┌──────────────────┐
│  Result Ingester  │──▶ writes each result to store
└──────────────────┘
                          │
                    ┌─────▼──────┐
                    │   Store    │  (results table: delivered = false)
                    └─────┬──────┘
                          │
                    ┌─────▼──────────┐
                    │ Delivery Worker │──▶ callback / webhook / event
                    └────────────────┘
                          │
                    on success: mark delivered = true
                    on failure: increment delivery_attempts, schedule retry
```

**Why:**
- **Crash safety** — partial progress is never lost. On restart, already-
  persisted results are deduplicated by `request_id`.
- **Memory efficiency** — no need to hold entire batch response in memory.
- **Independent retry** — delivery failures don't block ingestion.
- **Partial results** — succeeded requests are delivered immediately, no
  waiting for entire batch.

#### OpenAI Output File Handling

The OpenAI adapter downloads the output file and iterates line-by-line, feeding
each result into the same ingestion pipeline used by the Claude streaming path.

- Claude batches may deliver individual results sooner (as they complete);
  OpenAI batches deliver all at once (after download). This timing difference
  is invisible to consumers.
- For large output files, the adapter streams the download and parses JSONL
  line-by-line to keep memory bounded.

### 6.3 Polling

#### Adaptive Batch Polling

Pluggable polling strategies with built-in presets, clamped to safe ranges.
Per-batch strategy assignment, defaulting to a global strategy.

**Built-in presets:**

| Preset | Behavior | Best for |
|--------|----------|----------|
| `linear` | Fixed interval (default 60s) | Simple, predictable |
| `backoff` | Exponential: 30s → 60s → 120s → ... capped at 10min | Cost-sensitive, large batches |
| `deadline-aware` | Slow early, accelerates as `expiresAt` approaches | Freshness without early waste |
| `eager` | 15s for first 5 min, then fall back to `backoff` | Small batches expected to complete quickly |

**Clamping** (enforced regardless of strategy):
- Minimum interval: **10 seconds** (protects against rate limits).
- Maximum interval: **15 minutes** (ensures we don't miss expiry windows).

**Assignment:** Global default in config. Each batch can override at creation
time. Users can select presets or provide a custom strategy function.

#### Chat UI Polling

The chat UI uses HTTP polling (30–60s interval) to check for new results. No
WebSocket or SSE.

Rationale: norush is deferred-processing by design. Users submit and come back
later. A `GET /api/results?since={timestamp}` endpoint on a 30s timer is
simpler to build, debug, deploy, and scale than WebSocket. If push is ever
needed, SSE is the lighter upgrade path.

### 6.4 Rate Limiting, Spend Controls & Safety

#### Guardrails

| Guardrail | Scope | Default | Purpose |
|-----------|-------|---------|---------|
| `max_submission_attempts` | Per batch | 3 | Cap retries of orphaned batches (each may cost money) |
| `max_provider_retries` | Per batch | 5 | Cap retries of provider-rejected/expired batches (free) |
| `max_requests_per_period` | Per user | Configurable | Spend cap: max requests per rolling window |
| `max_tokens_per_period` | Per user | Configurable | Spend cap: estimated token budget per window |
| `hard_spend_limit` | Per user | Configurable | Absolute ceiling; rejects new requests |
| `circuit_breaker_threshold` | Global | 5 consecutive | Pause all submissions on cascading failures |
| `circuit_breaker_cooldown` | Global | 10 minutes | Wait before retrying after circuit breaker trips |

**Per-user spend limits:** When a user hits their norush spend limit, new
requests are rejected at queue time. Already-queued requests are not submitted
until the limit resets. In-flight batches (already submitted to the provider)
are allowed to complete — we don't cancel work that's already been paid for.

**Circuit breaker:** If N consecutive batch submissions fail (across all users),
norush pauses submissions and emits `circuit_breaker:tripped`. After cooldown,
resumes with a single probe batch. If the probe succeeds, normal operation
resumes. If it fails, cooldown resets.

#### Multi-Token Failover

Users may configure multiple API keys per provider:

```ts
providers: {
  claude: [
    { apiKey: 'sk-ant-primary-...', label: 'primary' },
    { apiKey: 'sk-ant-backup-...', label: 'backup' },
  ],
  openai: [
    { apiKey: 'sk-proj-main-...', label: 'main' },
  ],
}
```

Failover behavior:
1. Batches use the **primary key** by default.
2. On rate limit or credit exhaustion, norush **tries the next key** (if
   failover is enabled for that key pair).
3. If all keys exhausted, batch follows normal retry/failure flow.
4. Users can **disable failover** per key for strict billing separation.
5. Key selection recorded on batch record (`api_key_label`) for auditability.

#### Adaptive Rate Limiting with Health Scores

Per-user rate limiting with a dynamic health score that tightens limits when
batches are failing.

**Formula:** `effective_limit = base_limit × health_factor`

**Health computation:**

```ts
function computeHealth(window: SlidingWindow): HealthScore {
  const { succeeded, failed, total } = window;
  if (total === 0) return { factor: 1.0, reason: 'healthy' };

  const successRate = succeeded / total;

  if (successRate >= 0.9) return { factor: 1.0, reason: 'healthy' };
  if (successRate >= 0.5) return { factor: 0.5, reason: 'partial_failures' };
  if (successRate > 0)    return { factor: 0.25, reason: 'mostly_failing' };
  return                           { factor: 0.1, reason: 'critical' };
}
```

**Sliding window:** Configurable (default 1 hour). Tracks batches submitted,
succeeded, partially failed, fully failed. Updated on each batch completion.

| Health | Factor | Behavior |
|--------|--------|----------|
| `healthy` | 1.0 | Full rate. Normal operation. |
| `partial_failures` | 0.5 | Half rate. Likely hitting provider quota. |
| `mostly_failing` | 0.25 | Quarter rate. Likely exhausted API budget. |
| `critical` | 0.1 | Near-minimum. All recent batches failed. |

**Recovery:** Computed on every request admission using the current window. As
failed batches age out and successes enter, factor recovers automatically.
**Minimum throughput guarantee:** Even at `critical`, at least 1 request per
period is allowed — the avenue to prove recovery.

**429 response headers:**
- `Retry-After` (seconds until window slides)
- `X-Norush-Health: partial_failures` (reason)
- `X-Norush-Effective-Limit: 50` (current effective limit)

**Why adaptive over simple:** Simple rate limiting protects norush from volume
abuse. Adaptive additionally protects **users from wasting money** — throttling
down during failures is a service, not just a defense.

### 6.5 Webhook Delivery

#### HMAC-SHA256 Signing

Optional, activated when the user provides a signing secret. norush includes an
`X-Norush-Signature` header computed as `HMAC-SHA256(secret, request_body)`.
Without a secret, webhooks are sent unsigned. Users can rotate secrets at any
time; norush uses whatever is current at delivery time.

#### Delivery Guarantees

At-least-once delivery with exponential backoff:
- Every payload includes `norush_id` for consumer-side deduplication.
- Retry: 10s → 20s → 40s → ... capped at 10 min, up to `max_delivery_attempts`
  (default 5).
- After exhausting retries, `delivery_status` → `failed`. Result stays in store
  and can be re-delivered via user action.
- `X-Norush-Attempt: 3` header indicates retry count.
- **Separate retry domain:** Webhook delivery retries are independent of batch
  submission retries and polling. A down webhook doesn't block result ingestion.

### 6.6 Security & Data Governance

#### Encryption at Rest

AES-256-GCM symmetric encryption for stored API keys.

- Master key supplied via `NORUSH_MASTER_KEY` env var or secret manager — **not
  generated or stored by norush**. Knowable, deployable, IaC-compatible.
- Each API key encrypted with a unique IV per record, stored alongside
  ciphertext.
- **Key rotation:** Manual. CLI command re-encrypts all keys with new master.
  UI may display "key age" notice (e.g., "90+ days") as non-blocking reminder.
- Required before multi-user deployment. Plaintext in `MemoryStore` (tests
  only) is acceptable during early solo development.

#### Data Retention

norush stores prompt/response pairs that may contain sensitive data. Retention
policy controls how long content is kept after delivery (or terminal state).

| Policy | Behavior |
|--------|----------|
| `on_ack` | Scrub immediately after webhook 2xx ACK. **Encouraged for API/broker consumers.** |
| `1d` | Scrub 1 day after delivery / terminal state. |
| `7d` | Scrub after 7 days. **Default for `@norush/core` library.** |
| `30d` | Scrub after 30 days. **Default for norush.chat** (chat history is the product). |
| `custom` | User-specified duration in days. |

"Scrub" = replace `params` and `response` JSON with a tombstone
(`{"scrubbed": true, "scrubbed_at": "..."}`). Metadata (IDs, timestamps, token
counts, status) is preserved for billing, analytics, and debugging.

**Implementation:**
- Retention worker runs periodically (e.g., every hour).
- Respects user-configured policy from `user_settings`.
- Scrubbing is idempotent.
- `event_log` details scrubbed alongside parent records.
- **Hard upper limit:** System-wide maximum (e.g., 90 days) regardless of user
  setting. Configurable by operator.

#### Scope Boundary

norush does **not** own prompt chaining, transformation, or multi-step workflow
logic. It is a broker, not a workflow engine.

- **Chat users** interact with results manually.
- **API consumers** receive results via webhook. Chaining = their webhook
  handler submits new requests through the norush API.

The webhook → re-submit loop is the chaining mechanism, and it lives entirely
in user code. If a common chaining pattern emerges, we can add a lightweight
convenience layer, but the starting position is: norush is transport and
lifecycle management, not business logic.

### 6.7 Configuration & Observability

#### Three-Tier Configuration

```
┌─────────────────────────────────────────────────┐
│  Tier 1: Environment (env vars)                  │
│  Set by: infrastructure / deployment pipeline    │
│  NORUSH_MASTER_KEY, DATABASE_URL, WORKOS_API_KEY │
│  WORKOS_CLIENT_ID, NODE_ENV                      │
└──────────────────────┬──────────────────────────┘
                       │ overrides defaults
┌──────────────────────▼──────────────────────────┐
│  Tier 2: Operator config (file or env)           │
│  Set by: whoever deploys norush                  │
│  Retention cap, circuit breaker thresholds,      │
│  polling defaults, max batch sizes, global rate  │
│  limits, feature flags                           │
└──────────────────────┬──────────────────────────┘
                       │ overrides operator defaults
┌──────────────────────▼──────────────────────────┐
│  Tier 3: User settings (database)                │
│  Set by: end users via UI or API                 │
│  Retention policy (within cap), API keys,        │
│  webhook URLs, spend limits, polling strategy    │
└─────────────────────────────────────────────────┘
```

**Precedence rules:**
- User settings cannot exceed operator caps (e.g., 120d retention clamped to
  90d operator cap).
- Operator config cannot override environment settings.
- Defaults cascade: user → operator → library default (7d).

Implementation: `resolveConfig(env, operator, user)` merges tiers with
clamping. Tested with unit tests.

#### Telemetry

Define hooks and metric interfaces now. Wire up implementations later.

| Category | Metrics | Purpose |
|----------|---------|---------|
| Volume | `requests_queued`, `batches_submitted`, `results_ingested`, `deliveries_attempted` | Throughput |
| Latency | `batch_turnaround_ms`, `delivery_latency_ms` | Performance |
| Errors | `submission_failures`, `delivery_failures`, `circuit_breaker_trips`, `orphan_recoveries` | Reliability |
| Cost | `input_tokens_total`, `output_tokens_total` (per-model, per-user) | Billing analytics |
| Size | `batch_request_count`, `request_param_bytes`, `response_bytes` | Capacity planning |

Ship `NoopTelemetry` (default) and `ConsoleTelemetry` (debugging). Instrument
all key paths from day one. Prometheus / Datadog / OpenTelemetry adapters are
Phase 4 — hooks in place so adding them requires zero rework.

Token counts, batch sizes, and timing data survive content scrubbing, enabling
usage analysis and pricing research without retaining prompt/response content.

### 6.8 Authentication

WorkOS AuthKit for norush.chat:

- **Free tier:** 1M MAUs at no cost.
- **Features:** Email/password, social login (Google, GitHub), magic link,
  passkeys, MFA, enterprise SSO (SAML, Entra/Azure AD, Okta).
- **Integration:** Official TypeScript SDK. Drop-in hosted UI or embedded
  components.
- **Why not vanilla OAuth:** WorkOS gives enterprise-grade auth with less code
  than a single OAuth integration. Corporate identity provider support is a
  config change, not code.
- **Lock-in risk:** Moderate. Auth is an integration surface, not a data store.
  Migration to Auth0, Clerk, or self-hosted is scoped to the auth layer.

---

## 7. Technical Stack & Infrastructure

### 7.1 Stack Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Server + edge; largest LLM-tooling ecosystem |
| Runtime | Node.js >=24 | Active LTS (Krypton); poll loops + web servers |
| Database | PostgreSQL 17 everywhere | Full dev/prod parity; JSONB, TIMESTAMPTZ, partial indexes |
| PG client | `postgres.js` (Porsager) | ESM-native, zero deps, tagged template queries |
| Migrations | Raw SQL + minimal runner | Plain `.sql` files, `schema_migrations` table |
| IDs | `ulidx` | Time-sortable, B-tree friendly, actively maintained |
| Cloud | Azure Container Apps | Managed containers, scale-to-zero, web + worker |
| Web framework | SvelteKit (Svelte 5) | SSR + API routes, lighter than Next.js, runes |
| Auth | WorkOS AuthKit | 1M MAUs free; social, passkeys, enterprise SSO |
| Docker | Single image, two entrypoints | One build/test/push pipeline |
| Worker | Single event loop (`setInterval`) | I/O-bound concerns; split later if needed |
| Provider SDKs | `@anthropic-ai/sdk`, `openai` | Official; auth, retries, types |
| Testing | Vitest | Fast, TS-native |
| Package manager | pnpm workspaces | `@norush/core` + `@norush/web` monorepo |
| CI/CD | GitHub Actions | Zero friction with GitHub + Azure |

### 7.2 Deployment: Azure Container Apps

- Runs standard Docker containers. Supports multiple containers (web + worker).
  Consumption plan scales to zero. Managed HTTPS, custom domains, secrets
  integration (Azure Key Vault).
- **Database:** Azure Database for PostgreSQL Flexible Server. Same
  `DATABASE_URL` as local dev.
- **Why not Static Web Apps:** No long-running workers.
- **Why not Azure Functions:** Fragments architecture into separate units.
- **Why not App Service:** Container Apps has better scaling (scale-to-zero,
  KEDA).
- **Portability:** Dockerfile runs anywhere — AWS ECS, GCP Cloud Run,
  self-hosted.

### 7.3 Docker: Single Image, Two Entrypoints

```dockerfile
FROM node:24-slim AS base
# ... install pnpm, copy monorepo, install deps, build ...

FROM base AS runtime
COPY --from=base /app /app
WORKDIR /app
ENTRYPOINT ["node", "packages/web/dist/server.js"]
```

```yaml
# Azure Container Apps
- name: web
  image: norush:latest
  # Default entrypoint (web server)

- name: worker
  image: norush:latest
  command: ["node", "packages/core/dist/worker.js"]
```

| Container | Entrypoint | Responsibilities |
|-----------|-----------|-----------------|
| `web` | `packages/web/dist/server.js` | SvelteKit app, API routes, WorkOS auth, chat UI |
| `worker` | `packages/core/dist/worker.js` | Batch submission, polling, ingestion, delivery, retention |

Both share `DATABASE_URL` and `NORUSH_MASTER_KEY`. Communicate only through
the database.

### 7.4 PostgreSQL Client & Migrations

**postgres.js** — ESM-native, zero deps, tagged template queries make SQL
injection structurally impossible:
```ts
const rows = await sql`
  SELECT * FROM requests WHERE user_id = ${userId} AND status = ${status}
`;
```

**Migrations** — Numbered `.sql` files in `packages/core/migrations/`:
```
001_initial_schema.sql
002_add_health_score_fields.sql
...
```

Runner (~50 lines): reads directory, compares against `schema_migrations`
table, applies unapplied migrations in order inside a transaction. Callable as
`norush migrate` CLI or programmatically. If complexity grows (rollbacks, data
transforms), adopt a library later without losing existing SQL files.

### 7.5 ULID Generation

`ulidx` for all primary key generation. ULIDs encode a millisecond timestamp
(first 48 bits) + 80 bits of randomness:

- **Lexicographic sort = creation order** — `ORDER BY id` gives chronological
  order.
- **B-tree friendly** — monotonically increasing inserts at rightmost leaf page.
- **Extractable timestamp** — decode creation time from the ID without DB
  lookup.

`ulidx` over `ulid`: the original package stalled (~2021); `ulidx` is the
actively maintained successor (native ESM, zero deps).

### 7.6 Worker Process

Single Node.js process with `setInterval` for each concern: batch polling,
result delivery, retention scrubbing. All I/O-bound — single event loop handles
this naturally. Split into separate processes only if a concern becomes
CPU-bound.

### 7.7 CI/CD: GitHub Actions

- **On push/PR:** Lint + type-check + test.
- **On merge to main:** Build + push Docker image.
- **Deploy:** Azure Container Apps via Azure's official GitHub Actions.
- YAML-based; portable to other CI providers if needed.

---

## 8. Implementation Phases

### Phase 1: Core Library MVP

**Goal:** Working `@norush/core` that can batch, submit, poll, and deliver.

**Project setup:**
- [ ] pnpm monorepo: `@norush/core` + `@norush/web` workspaces
- [ ] TypeScript config, build tooling
- [ ] Vitest test setup
- [ ] GitHub Actions: lint + type-check + test on push/PR
- [ ] Docker Compose for local PostgreSQL 17

**Persistence:**
- [ ] Initial migration (`001_initial_schema.sql`) — full schema from Sec 4.1
- [ ] Migration runner (~50 lines, `schema_migrations` table)
- [ ] `PostgresStore` implementation (all `Store` interface methods)
- [ ] `MemoryStore` for unit tests

**Core interfaces & types:**
- [ ] `Provider`, `Store`, `NorushRequest`, `NorushResult`, `Batch` (Sec 3.3)
- [ ] `PollingStrategy` + 4 presets: linear, backoff, deadline-aware, eager
      (Sec 6.3)
- [ ] `TelemetryHook` + `NoopTelemetry` + `ConsoleTelemetry` (Sec 6.7)
- [ ] `HealthScore` type (Sec 6.4)
- [ ] Config types + `resolveConfig(env, operator, user)` with clamping
      (Sec 6.7)

**Provider adapters:**
- [ ] `ClaudeAdapter` — Anthropic Message Batches API (Sec 2.1)
- [ ] `OpenAIBatchAdapter` — OpenAI Batch API with JSONL file upload (Sec 2.2)

**Engine:**
- [ ] Request Queue — accept, assign ULID, flush triggers (count/bytes/time)
- [ ] Batch Manager — group by `(provider, model, api_key)`, format, submit
- [ ] Write-before-submit idempotency + orphan recovery (Sec 6.1)
- [ ] Status Tracker — poll loop with adaptive strategy (Sec 6.3)
- [ ] Two-phase Result Router — ingestion + delivery via callbacks/events
      (Sec 6.2)
- [ ] Partial batch failure handling + automatic repackaging (Sec 6.1)
- [ ] Guardrails: submission attempt caps, provider retry caps, circuit
      breaker (Sec 6.4)

**Testing:**
- [ ] Unit tests with `MemoryStore`
- [ ] Integration tests against real provider APIs (small batches)
- [ ] Config resolution edge cases

### Phase 2: Deferred Chat Web App

**Goal:** norush.chat deployed on Azure.

**Web application:**
- [ ] SvelteKit app scaffolding (Svelte 5, runes)
- [ ] WorkOS AuthKit integration — login, signup, session management (Sec 6.8)
- [ ] AES-256-GCM API key encryption via `NORUSH_MASTER_KEY` (Sec 6.6)
- [ ] Chat UI — message list with queued/pending/received states
- [ ] HTTP polling for result updates, 30–60s interval (Sec 6.3)
- [ ] Cost savings indicator
- [ ] Notification system (in-app + optional email)

**Infrastructure:**
- [ ] Dockerfile — single image, multi-stage build, two entrypoints (Sec 7.3)
- [ ] Worker entrypoint — single event loop: polling + delivery + retention
      (Sec 7.6)
- [ ] Azure Container Apps deployment — web + worker containers (Sec 7.2)
- [ ] Azure Database for PostgreSQL Flexible Server
- [ ] GitHub Actions: build + push Docker image on merge to main (Sec 7.7)

### Phase 3: Broker Mode + REST API

**Goal:** Programmatic access with webhook delivery and safety controls.

**API & delivery:**
- [ ] REST API for request submission, status queries, result retrieval
- [ ] Webhook delivery with HMAC-SHA256 signing (Sec 6.5)
- [ ] At-least-once delivery with exponential backoff (Sec 6.5)
- [ ] Multi-token failover — multiple keys per provider with priority (Sec 6.4)
- [ ] User-triggered re-submission of terminal requests (Sec 6.1)

**Safety & monitoring:**
- [ ] Per-user spend limits — request/token/USD caps (Sec 6.4)
- [ ] Adaptive rate limiting with health scores (Sec 6.4)
- [ ] Usage dashboard (batches, costs, response times)

### Phase 4: Polish & Ecosystem

**Goal:** Production-ready, publishable, observable.

- [ ] OpenAI Flex adapter — cheap synchronous fallback (Sec 2.3)
- [ ] Data retention worker — periodic scrubbing + hard cap enforcement
      (Sec 6.6)
- [ ] Master key rotation CLI command (Sec 6.6)
- [ ] npm publish `@norush/core`
- [ ] Documentation site
- [ ] Prometheus / Datadog / OpenTelemetry adapters (Sec 6.7)
- [ ] GitHub Actions / cron integration examples
- [ ] Deploy-to-Azure template
