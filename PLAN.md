# norush - Design & Implementation Plan

## 1. Problem Statement

LLM APIs from Anthropic and OpenAI both offer **deferred/batch processing** at
**50% cost reduction**. These APIs are asynchronous: you submit requests, wait
(minutes to hours), then retrieve results. Today, every developer who wants to
use these APIs must build their own:

- Request batching and submission logic
- Persistent tracking of in-flight batches
- Polling / status-check scheduling
- Result retrieval and routing
- Error handling, retries, expiration recovery
- Multi-provider abstraction

**norush** eliminates this by providing a reusable deferred-execution engine
that handles the full lifecycle, and then building a consumer-facing product on
top of it.

---

## 2. Research Summary: Provider APIs

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
- **Two-step submission**: upload JSONL file first, then create batch referencing file ID.
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

### 3.1 Core Library: `@norush/core`

A TypeScript/Node.js library (publishable to npm) that manages the full
deferred-request lifecycle. Provider-agnostic at the consumer level.

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

### 3.2 Key Components

#### Request Queue
- Accepts individual prompt requests with metadata (provider, model, priority,
  callback config).
- Assigns a unique `norush_id` to each request.
- Holds requests until a batch flush is triggered (by count threshold, byte
  limit, time window, or manual flush).

#### Batch Manager
- Groups queued requests by provider + model (a batch can only go to one
  provider endpoint).
- Serializes to the provider-specific format (JSON body for Claude, JSONL file
  for OpenAI).
- Submits and records the provider's batch ID mapped to all `norush_id`s
  within it.

#### Provider Adapters
- **ClaudeAdapter**: Wraps Anthropic's Message Batches API.
- **OpenAIBatchAdapter**: Wraps OpenAI's Batch API (file upload + batch create).
- **OpenAIFlexAdapter** (optional): Wraps flex synchronous calls with retry/backoff.
- Each adapter implements a common interface:
  ```ts
  interface Provider {
    submitBatch(requests: NorushRequest[]): Promise<ProviderBatchRef>
    checkStatus(ref: ProviderBatchRef): Promise<BatchStatus>
    fetchResults(ref: ProviderBatchRef): Promise<NorushResult[]>
    cancelBatch(ref: ProviderBatchRef): Promise<void>
  }
  ```

#### Status Tracker
- Runs a **poll loop** (configurable interval, default 60s) that checks all
  in-flight batches.
- Emits events: `batch:submitted`, `batch:processing`, `batch:completed`,
  `batch:expired`, `batch:error`.
- Handles retries on expiry (re-queue the requests into a new batch).
- Can be driven by:
  - An internal `setInterval` (for long-running Node processes).
  - An external cron/timer calling `tracker.tick()` (for serverless / static
    environments).

#### Result Router (Two-Phase Pipeline)
- **Phase A — Ingestion:** Streams results from the provider one at a time,
  persists each to the store immediately. Crash-safe: partial progress is
  never lost.
- **Phase B — Delivery:** A separate loop reads undelivered results from the
  store and fans them out via the configured mechanism per-request:
  - **Callback function** (in-process).
  - **Webhook POST** (for remote consumers, with optional HMAC-SHA256 signing).
  - **Event emitter** (for pub/sub patterns).
  - **Storage write** (persist to DB/file for later retrieval).
- Delivery tracks attempts, supports retry with backoff, and operates
  independently of ingestion. See Section 9.3 for full design.

#### Store (SPI = Service Provider Interface)
- An interface for persistence. The core library does not bundle a database —
  consumers provide an adapter.
- Built-in adapters:
  - `MemoryStore` — for tests and ephemeral use.
  - `SQLiteStore` — for single-server / CLI deployments.
  - `PostgresStore` (or similar) — for production web apps.
- What's stored:
  - Requests: `norush_id`, provider, model, params, status, created_at, batch_ref.
  - Batches: `batch_id`, provider_batch_id, status, submitted_at, ended_at.
  - Results: `norush_id`, response body, received_at, delivery_status.

### 3.3 Configuration

```ts
const norush = createNorush({
  providers: {
    claude: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
  store: new SQLiteStore('./norush.db'),
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

## 4. Consumer Applications

### 4.1 Application A: "norush.chat" — Deferred Chat Web App

A web application where users log in, provide their own API keys, and use a
chat interface designed around **non-urgent conversations**.

**User flow:**
1. User signs up / logs in.
2. User adds their Anthropic and/or OpenAI API keys (encrypted at rest).
3. User writes messages throughout the day — thoughts, questions, research
   requests — with no expectation of immediate response.
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
Browser (React/Next.js)
    │
    ▼
API Server (Node.js)
    │
    ├── Auth (OAuth / email+password)
    ├── Key vault (encrypted API key storage)
    ├── @norush/core (batch engine)
    ├── PostgresStore (persistence)
    └── Cron worker (tick the status tracker)
```

### 4.2 Application B: "Broker Mode" — norush as a Service

An extension of the chat app where users configure **webhook endpoints**.
norush acts as a batch-processing broker:

1. User submits prompts via UI or API.
2. norush batches and processes them.
3. On result arrival, norush POSTs responses to the user's configured endpoint.

This lets developers use norush as managed infrastructure without self-hosting
the batch lifecycle.

### 4.3 Application C: CLI / Library for Developers

Developers `npm install @norush/core` and use it directly in their own apps,
scripts, or pipelines. Example: overnight news summarization, bulk content
generation, scheduled analysis jobs.

---

## 5. What Makes norush Non-Trivial

The natural question: why wouldn't someone just call the batch API directly?

1. **Multi-provider abstraction** — One interface, multiple backends. Switch
   models without changing application code.
2. **Lifecycle management** — Automatic batching, polling, retry on expiry,
   result routing. The "boring but necessary" plumbing.
3. **Persistence by design** — Every request/response pair is tracked and
   recoverable. Crash-safe: the process can restart and pick up where it left.
4. **Composability** — Chain batch results into subsequent batches. Build
   multi-step pipelines of deferred work.
5. **Multi-tenant key management** — The broker model lets many users submit
   through one server, each with their own API keys.
6. **Scheduling** — Integration with cron or timer-based execution for
   environments that aren't always-on.

---

## 6. Implementation Phases

### Phase 1: Core Library + SQLite Store (MVP)
- [ ] Project scaffolding (TypeScript, build tooling, tests)
- [ ] Define core interfaces: `Provider`, `Store`, `NorushRequest`, `NorushResult`
- [ ] Implement `ClaudeAdapter` (Anthropic Message Batches API)
- [ ] Implement `OpenAIBatchAdapter` (OpenAI Batch API)
- [ ] Implement `MemoryStore` and `SQLiteStore`
- [ ] Implement Request Queue + Batch Manager
- [ ] Implement Status Tracker (poll loop)
- [ ] Implement Result Router (callback + event emitter)
- [ ] Integration tests with real API calls (small batches)
- [ ] CLI tool for manual batch submission and status checking

### Phase 2: Deferred Chat Web App
- [ ] Next.js app scaffolding
- [ ] Auth system (NextAuth or similar)
- [ ] Encrypted API key storage
- [ ] Chat UI (message list with sent/pending/received states)
- [ ] Background worker for status polling
- [ ] Notification system (in-app + optional email)
- [ ] Deploy (Vercel + managed Postgres, or self-hosted)

### Phase 3: Broker Mode + API
- [ ] REST API for programmatic prompt submission
- [ ] Webhook delivery with retry and signing
- [ ] Usage dashboard (batches sent, costs, response times)
- [ ] Rate limiting and abuse prevention

### Phase 4: Polish & Ecosystem
- [ ] OpenAI Flex adapter as fallback mode
- [ ] Pipeline/chaining API for multi-step workflows
- [ ] npm publish `@norush/core`
- [ ] Documentation site
- [ ] GitHub Actions / cron integration examples

---

## 7. Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Runs on server and edge; largest LLM-tooling ecosystem; both provider SDKs available |
| Runtime | Node.js (>=20) | Stable LTS, good for long-running poll loops and web servers |
| Default store | SQLite via `better-sqlite3` | Zero-config, single-file, perfect for CLI and single-server use |
| Web framework | Next.js (App Router) | SSR + API routes + React in one; easy deployment |
| Package manager | pnpm | Fast, disk-efficient, good monorepo support |
| Monorepo | pnpm workspaces | Keep `@norush/core` and `@norush/web` in one repo |
| Provider SDKs | `@anthropic-ai/sdk`, `openai` | Official SDKs; handle auth, retries, types |
| Testing | Vitest | Fast, TS-native, compatible with Node APIs |

---

## 8. Data Model

See **Section 11** for the full, updated data model reflecting all resolved
design decisions (multi-key support, retry counters, delivery tracking, spend
limits, audit log).

---

## 9. Resolved Design Decisions

### 9.1 Multi-User Key Isolation

**Decision:** Separate batches per API key. A batch sent to a provider is
always authenticated with exactly one API key, and billing is tied to that key.
Even if two users happen to use the same provider and model, their requests
form distinct batches because each user's key is the authentication boundary.

Implication: the Batch Manager groups requests by `(provider, model, api_key)`,
not just `(provider, model)`.

### 9.2 Webhook Security

**Decision:** HMAC-SHA256 signing is **optional**, activated only when the user
provides a signing secret for their webhook endpoint.

- If a signing secret is configured, norush includes an `X-Norush-Signature`
  header on every webhook POST, computed as
  `HMAC-SHA256(secret, request_body)`.
- If no secret is configured, webhooks are sent unsigned. This keeps the
  barrier to entry low for users who just want to receive results.
- The user can rotate their signing secret at any time; norush uses whatever
  is current at delivery time.

### 9.3 Streaming Result Ingestion & Two-Phase Delivery

**Decision:** Decouple result ingestion from result delivery as a two-phase
pipeline.

**Phase A — Ingestion:** As provider results stream in (e.g., Claude SDK's
`results()` iterator, or line-by-line reading of OpenAI's output JSONL), each
individual result is immediately written to the `results` table in the store.
The batch does not need to be fully complete before individual results are
persisted.

**Phase B — Delivery (fan-out):** A separate delivery loop reads undelivered
results from the store and fans them out to the configured destination
(callback, webhook, event emitter). Delivery is tracked independently per
result.

**Why this matters:**
- **Crash safety:** If ingestion crashes midway through streaming a batch's
  results, the already-persisted results are not lost. On restart, ingestion
  picks up from where it left off (results already in the store are
  deduplicated by `request_id`).
- **Memory efficiency:** No need to hold the entire batch response in memory.
  Results are processed one at a time.
- **Independent retry:** Delivery failures (e.g., webhook endpoint is down)
  do not block ingestion of new results. Delivery retries operate on their
  own schedule.
- **Partial batch results:** When a batch has a mix of succeeded and failed
  requests, succeeded results are ingested and delivered immediately — no
  waiting for the entire batch to resolve.

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

### 9.4 Idempotency, Crash Recovery & Guardrails

**Decision:** Write-before-submit with orphan recovery and layered guardrails.

#### Submission Protocol

1. **Before calling the provider API**, write a batch record to the store with
   `status: 'pending'` and `submission_attempts: 0`.
2. Increment `submission_attempts` to 1 and call the provider API.
3. On success, update the batch record with `provider_batch_id` and
   `status: 'submitted'`.
4. On failure, leave `provider_batch_id` as NULL; the batch is now an orphan
   candidate.

#### Orphan Recovery

On each poll cycle, the Status Tracker scans for batches where:
- `status = 'pending'`
- `provider_batch_id IS NULL`
- `updated_at < NOW() - grace_period` (default: 5 minutes)
- `submission_attempts < max_submission_attempts`

These are presumed orphans from a crashed process. The tracker increments
`submission_attempts` and re-submits. If `submission_attempts` reaches
`max_submission_attempts` (default: 3), the batch transitions to
`status: 'failed'` and its requests become eligible for user-triggered
re-submission.

**Accepted trade-off:** Orphan recovery may cause double-submission if the
original process was merely slow (not crashed). This can result in double
billing. We accept this: it is better to pay twice and get the results than
to pay once and lose them. The grace period and attempt cap keep this bounded.

#### Guardrails

| Guardrail | Scope | Default | Purpose |
|-----------|-------|---------|---------|
| `max_submission_attempts` | Per batch | 3 | Cap retries of orphaned batches (each attempt may cost money) |
| `max_provider_retries` | Per batch | 5 | Cap retries of batches that the provider rejected/expired (these are free) |
| `max_requests_per_period` | Per user | Configurable | Spend cap: max requests a user can submit in a rolling window |
| `max_tokens_per_period` | Per user | Configurable | Spend cap: estimated token budget per rolling window |
| `hard_spend_limit` | Per user | Configurable | Absolute ceiling; rejects new requests when reached |
| `circuit_breaker_threshold` | Global | 5 consecutive failures | Pause all submissions if failures cascade, to prevent runaway costs |
| `circuit_breaker_cooldown` | Global | 10 minutes | How long to wait before retrying after circuit breaker trips |

Every batch record carries counters:
- `submission_attempts` — how many times we tried to submit to the provider.
- `provider_retries` — how many times the provider failed/expired and we re-queued.

Every request record carries:
- `retry_count` — how many batches this request has been part of (for requests
  that were repackaged after partial batch failure).

The circuit breaker is a global safety net. If N consecutive batch submissions
fail (across all users), norush pauses submissions entirely and emits a
`circuit_breaker:tripped` event. After the cooldown, it resumes with a single
probe batch. If the probe succeeds, normal operation resumes. If it fails,
the cooldown resets.

### 9.5 Adaptive Polling

**Decision:** Pluggable polling strategies with built-in presets, clamped to
safe ranges. Per-batch strategy assignment, defaulting to a global strategy.

#### Strategy Interface

```ts
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
  /** Provider's stated completion window (e.g., 24h) */
  expiresAt: Date;
}
```

#### Built-In Presets

| Preset | Behavior | Best for |
|--------|----------|----------|
| `linear` | Fixed interval (default 60s) | Simple, predictable |
| `backoff` | Exponential backoff: 30s → 60s → 120s → ... capped at 10min | Cost-sensitive users, large batches |
| `deadline-aware` | Slow early, accelerates as `expiresAt` approaches. Backoff for the first 50% of the window, then linear 30s for the final 50% | Maximizing freshness without early waste |
| `eager` | Poll every 15s for the first 5 min, then fall back to `backoff` | Small batches expected to complete quickly |

#### Clamping

Regardless of strategy (including user-supplied), norush enforces:
- **Minimum interval:** 10 seconds (protects against API rate limits on status
  endpoints).
- **Maximum interval:** 15 minutes (ensures we don't miss expiry windows).

#### Assignment

- A global default strategy is set in norush configuration.
- Each batch can override with a specific strategy at creation time.
- In future iterations, users can select from presets or provide a custom
  strategy function (within clamped limits).

---

## 10. Credit Limits, Partial Failures & Multi-Token Failover

### 10.1 The Problem

Provider API limits can cause a batch to **partially succeed**: some requests
complete, others fail because a rate limit, token quota, or spend cap was hit
mid-batch. Additionally, norush itself may enforce per-user spend limits that
prevent new batches from being submitted.

### 10.2 Per-Request Status Within a Batch

Each request within a batch has its own status independent of the batch's
overall status. When a batch ends, norush inspects per-request results:

| Request outcome | Action |
|----------------|--------|
| `succeeded` | Ingest result, queue for delivery |
| `errored` (provider error) | Mark as `failed`, eligible for repackaging |
| `expired` (batch timed out before processing) | Mark as `expired`, eligible for repackaging |
| `canceled` (batch was canceled) | Mark as `canceled`, eligible for user re-trigger |

"Eligible for repackaging" means the request can be automatically included in
a retry batch (subject to the retry budget from Section 9.4). "Eligible for
user re-trigger" means the request sits in a terminal state until the user
explicitly asks to retry it.

### 10.3 Automatic Repackaging

When a batch completes with a mix of succeeded and failed requests:

1. **Succeeded requests:** Results are immediately ingested and queued for
   delivery (per Section 9.3).
2. **Failed/expired requests:** If `retry_count < max_provider_retries`, these
   requests are collected into a new batch and re-queued. Their `retry_count`
   is incremented. The new batch follows the same lifecycle as any other batch.
3. **Exhausted retries:** Requests that exceed their retry budget transition to
   `status: 'failed_final'`. They remain in the store and can be re-triggered
   by the user at any time.

### 10.4 User-Triggered Re-Submission

Users can explicitly re-trigger any request in a terminal state (`failed_final`,
`canceled`, `expired_final`). This:

1. Resets `retry_count` to 0.
2. Sets `status` back to `queued`.
3. The request enters the normal batching flow again.

This is a deliberate user action, not an automatic retry — so it is not
constrained by the retry budget (though it is still constrained by the user's
spend limits).

### 10.5 Multi-Token Failover

Users may configure **multiple API keys** per provider (or even for the same
provider, e.g., keys from different billing accounts or organizations).

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

**Failover behavior:**

1. Batches are submitted using the **first (primary) key** by default.
2. If submission fails due to a rate limit or credit exhaustion error, norush
   **tries the next key** in the list (if one exists and the user has enabled
   failover for that key pair).
3. If all keys for a provider are exhausted, the batch follows the normal
   retry/failure flow.
4. Users can **disable failover** per key if they want strict control over
   which key is used (e.g., to keep billing separate).
5. Key selection is recorded on the batch record (`api_key_label`) for
   auditability.

### 10.6 norush-Level Spend Limits

Independent of provider-side limits, norush enforces its own per-user limits
(Section 9.4 guardrails). When a user hits their norush spend limit:

- New requests are **rejected at queue time** with a clear error.
- Already-queued requests are **not submitted** until the limit resets or the
  user raises it.
- In-flight batches (already submitted to the provider) are allowed to complete
  — we don't cancel work that's already been paid for.

---

## 11. Updated Data Model

```sql
-- Per-user configuration and limits
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE user_api_keys (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,       -- FK to users.id
  provider              TEXT NOT NULL,        -- 'claude' | 'openai'
  label                 TEXT NOT NULL,        -- 'primary', 'backup', etc.
  api_key_encrypted     BLOB NOT NULL,        -- encrypted at rest
  priority              INTEGER NOT NULL DEFAULT 0,  -- lower = tried first
  failover_enabled      INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE user_limits (
  user_id               TEXT PRIMARY KEY,     -- FK to users.id
  max_requests_per_hour INTEGER,              -- NULL = unlimited
  max_tokens_per_day    INTEGER,              -- NULL = unlimited
  hard_spend_limit_usd  REAL,                 -- NULL = unlimited
  current_period_requests INTEGER NOT NULL DEFAULT 0,
  current_period_tokens   INTEGER NOT NULL DEFAULT 0,
  period_reset_at       TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- A single prompt/request submitted by a consumer
CREATE TABLE requests (
  id                    TEXT PRIMARY KEY,     -- norush_id (ULID)
  external_id           TEXT,                 -- custom_id sent to provider
  provider              TEXT NOT NULL,        -- 'claude' | 'openai'
  model                 TEXT NOT NULL,        -- e.g. 'claude-sonnet-4-6'
  params                JSON NOT NULL,        -- full request params
  status                TEXT NOT NULL DEFAULT 'queued',
                        -- queued | batched | processing | succeeded
                        -- | failed | expired | failed_final | canceled
  batch_id              TEXT,                 -- FK to batches.id (current batch)
  user_id               TEXT NOT NULL,        -- FK to users.id
  callback_url          TEXT,                 -- optional webhook for this request
  webhook_secret        TEXT,                 -- optional HMAC signing secret
  retry_count           INTEGER NOT NULL DEFAULT 0, -- times repackaged into a new batch
  max_retries           INTEGER NOT NULL DEFAULT 5, -- per-request retry budget
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- A batch submitted to a provider
CREATE TABLE batches (
  id                    TEXT PRIMARY KEY,     -- internal batch ID (ULID)
  provider              TEXT NOT NULL,
  provider_batch_id     TEXT,                 -- ID returned by provider (NULL until confirmed)
  api_key_id            TEXT NOT NULL,        -- FK to user_api_keys.id (which key was used)
  api_key_label         TEXT,                 -- denormalized for easy auditing
  status                TEXT NOT NULL DEFAULT 'pending',
                        -- pending | submitted | processing | ended
                        -- | expired | cancelled | failed
  request_count         INTEGER NOT NULL DEFAULT 0,
  succeeded_count       INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,
  submission_attempts   INTEGER NOT NULL DEFAULT 0,  -- times we tried to submit (orphan recovery)
  max_submission_attempts INTEGER NOT NULL DEFAULT 3,
  provider_retries      INTEGER NOT NULL DEFAULT 0,  -- times provider failed and we re-queued
  max_provider_retries  INTEGER NOT NULL DEFAULT 5,
  polling_strategy      TEXT,                 -- override strategy name, NULL = use global default
  submitted_at          TEXT,
  ended_at              TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Responses received from providers
CREATE TABLE results (
  id                    TEXT PRIMARY KEY,     -- ULID
  request_id            TEXT NOT NULL UNIQUE, -- FK to requests.id (1:1)
  batch_id              TEXT NOT NULL,        -- FK to batches.id
  response              JSON NOT NULL,        -- full provider response
  stop_reason           TEXT,                 -- end_turn, max_tokens, etc.
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  -- Delivery tracking (Phase B of two-phase pipeline)
  delivery_status       TEXT NOT NULL DEFAULT 'pending',
                        -- pending | delivered | failed | no_target
  delivery_attempts     INTEGER NOT NULL DEFAULT 0,
  max_delivery_attempts INTEGER NOT NULL DEFAULT 5,
  last_delivery_error   TEXT,                 -- last failure reason
  next_delivery_at      TEXT,                 -- for retry scheduling (backoff)
  delivered_at          TEXT,
  created_at            TEXT NOT NULL
);

-- Audit log for significant events (optional but recommended)
CREATE TABLE event_log (
  id                    TEXT PRIMARY KEY,
  entity_type           TEXT NOT NULL,        -- 'batch' | 'request' | 'result'
  entity_id             TEXT NOT NULL,
  event                 TEXT NOT NULL,        -- 'submitted', 'orphan_recovered',
                                              -- 'circuit_breaker_tripped', etc.
  details               JSON,
  created_at            TEXT NOT NULL
);
```

### Key differences from the original draft:

- **`user_api_keys`** — Supports multiple keys per provider with priority
  ordering and failover toggle.
- **`user_limits`** — Per-user spend caps with rolling counters.
- **`requests.retry_count` / `max_retries`** — Per-request retry budget
  tracking for repackaging.
- **`batches.submission_attempts` / `max_submission_attempts`** — Orphan
  recovery counter.
- **`batches.provider_retries` / `max_provider_retries`** — Provider-failure
  retry counter (separate from orphan retries since these are free).
- **`batches.api_key_id` / `api_key_label`** — Track which key was used.
- **`batches.polling_strategy`** — Per-batch polling override.
- **`results.delivery_*` fields** — Full delivery lifecycle tracking for
  the two-phase pipeline.
- **`event_log`** — Audit trail for debugging and observability.

---

## 12. Remaining Open Questions

- **Encryption at rest for API keys:** What encryption scheme for
  `user_api_keys.api_key_encrypted`? AES-256-GCM with a server-side master
  key is the straightforward choice. Key rotation strategy TBD.
- **Batch result streaming vs. polling for OpenAI:** OpenAI's batch API
  requires downloading an output file (not streaming individual results).
  We'll need to download the file and then iterate line-by-line to simulate
  streaming. This is a provider adapter concern, not a core architecture
  issue.
- **Webhook delivery guarantees:** At-least-once with exponential backoff is
  the pragmatic choice. We should document that consumers must be idempotent
  (include `norush_id` in every payload so they can deduplicate).
- **Multi-step pipelines:** How should chained batches be defined? A simple
  approach: the result callback for step N queues requests for step N+1.
  A richer approach: a pipeline definition DSL. Start simple, evolve if needed.
