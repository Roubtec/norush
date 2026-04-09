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
Browser (SvelteKit)
    │
    ▼
API Server (SvelteKit server routes / Node.js)
    │
    ├── Auth (WorkOS AuthKit — social, passkeys, enterprise SSO)
    ├── Key vault (AES-256-GCM encrypted API key storage)
    ├── @norush/core (batch engine)
    ├── Store adapter (SQLite local / PostgreSQL cloud)
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
4. **Broker model** — Delivers results to webhooks, enabling clients to
   chain further work through norush's API on their own terms.
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
- [ ] SvelteKit app scaffolding
- [ ] WorkOS AuthKit integration (social login, enterprise SSO)
- [ ] Encrypted API key storage
- [ ] Chat UI (message list with sent/pending/received states)
- [ ] Background worker for status polling
- [ ] Notification system (in-app + optional email)
- [ ] Deploy (cloud host + managed PostgreSQL)

### Phase 3: Broker Mode + API
- [ ] REST API for programmatic prompt submission
- [ ] Webhook delivery with retry and signing
- [ ] Usage dashboard (batches sent, costs, response times)
- [ ] Rate limiting and abuse prevention

### Phase 4: Polish & Ecosystem
- [ ] OpenAI Flex adapter as fallback mode
- [ ] npm publish `@norush/core`
- [ ] Documentation site
- [ ] GitHub Actions / cron integration examples
- [ ] Data retention cleanup job and configurable TTL policies

---

## 7. Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Runs on server and edge; largest LLM-tooling ecosystem; both provider SDKs available |
| Runtime | Node.js (>=24) | Active LTS (Krypton); good for long-running poll loops and web servers |
| Default store | SQLite via `better-sqlite3` | Zero-config, single-file, perfect for CLI and single-server. Adapter pattern allows promotion to PostgreSQL for cloud (see Section 12.5) |
| Production store | PostgreSQL | Required for horizontal scaling; Azure Database for PostgreSQL Flexible Server or equivalent |
| Web framework | SvelteKit | SSR + API routes + lighter bundles than Next.js; Svelte 5 reactivity is a natural fit for chat UIs |
| Auth | WorkOS AuthKit | 1M MAUs free; social login, passkeys, MFA, enterprise SSO (SAML, Entra) out of the box; TS SDK |
| Package manager | pnpm | Fast, disk-efficient, good monorepo support |
| Monorepo | pnpm workspaces | Keep `@norush/core` and `@norush/web` in one repo |
| Provider SDKs | `@anthropic-ai/sdk`, `openai` | Official SDKs; handle auth, retries, types |
| Testing | Vitest | Fast, TS-native, compatible with Node APIs |

---

## 8. Data Model

See **Section 11** for the full data model (multi-key support, retry counters,
delivery tracking, spend limits, audit log) and **Section 13.4** for the
retention policy additions (`user_settings`, scrub timestamps).

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

## 12. Additional Resolved Decisions

### 12.1 Encryption at Rest for API Keys

**Decision:** AES-256-GCM symmetric encryption with an externally provided
master key.

- The master key is **not generated or stored by norush**. It is supplied via
  environment variable (`NORUSH_MASTER_KEY`) or secret manager reference at
  startup.
- This means the key is a **knowable, deployable secret** — compatible with
  IaC (Terraform, Pulumi), container orchestration (K8s Secrets, ECS task
  definitions), and horizontal scaling (all instances share the same key).
- Each API key is encrypted with a unique IV (initialization vector) derived
  per record, stored alongside the ciphertext.
- **Key rotation:** Manual for now. The user can rotate their master key by
  running a migration command that re-encrypts all stored API keys with the
  new key. The UI may display a "key age" notice (e.g., "Master key has been
  in use for 90+ days") as a non-blocking reminder, not a hard requirement.
- This is not critical-path for the core library MVP — the `MemoryStore` and
  early `SQLiteStore` can store keys in plaintext during development. Encryption
  is required before any multi-user deployment.

### 12.2 OpenAI Output File Handling

**Decision:** The OpenAI adapter downloads the completed output file and
iterates line-by-line, feeding each result into the same ingestion pipeline
used by the Claude streaming path.

- This means Claude batches may deliver individual results **sooner** (as they
  complete within the batch), while OpenAI batches deliver all results at once
  (after the full batch completes and the output file is downloaded).
- From the consumer's perspective, this is invisible — results arrive via the
  same delivery mechanism regardless of provider. The timing difference is a
  provider characteristic, not a norush design choice.
- For very large OpenAI output files, the adapter streams the file download
  (not buffering the entire file in memory) and parses JSONL line-by-line.
  This keeps memory usage bounded regardless of batch size.

### 12.3 Webhook Delivery Guarantees

**Decision:** At-least-once delivery with exponential backoff and idempotency
support.

- Every webhook payload includes `norush_id` (the request's unique ID) so
  that consumers can **deduplicate** on their end. norush guarantees
  at-least-once delivery, not exactly-once.
- Retry schedule: exponential backoff starting at 10s, doubling up to a cap
  of 10 minutes, for up to `max_delivery_attempts` (default 5) tries.
- After exhausting retries, the result's `delivery_status` transitions to
  `failed`. The result remains in the store (subject to retention policy) and
  can be re-delivered via user action or API call.
- Webhook payloads include a delivery attempt counter (`X-Norush-Attempt: 3`)
  so the consumer knows if this is a retry.
- **Separate retry domain from provider interactions:** Webhook delivery
  retries are independent of batch submission retries and polling. A webhook
  endpoint being down does not affect norush's ability to ingest new results
  or submit new batches.

### 12.4 Scope Boundary: No Built-In Pipeline Orchestration

**Decision:** norush does **not** own prompt chaining, transformation, or
multi-step workflow logic. It is a broker, not a workflow engine.

**Rationale:** norush's value is in the batch lifecycle — accept requests,
submit them cheaply, track progress, deliver results. Business logic about
what to do with results belongs to the consumer:

- **Chat users** interact with results manually. No automation needed.
- **API consumers** receive results via webhook. If they want to chain further
  work, their webhook handler submits new requests through the norush API.
  norush processes those lazily, delivers results, and the cycle repeats.

This keeps norush focused and avoids becoming a workflow orchestration platform
(a different product category — Temporal, Step Functions, etc.). The webhook →
re-submit loop is the chaining mechanism, and it lives entirely in user code.

If a pattern emerges where many consumers build the same chaining logic, we
can revisit with a lightweight convenience layer. But the starting position is:
norush is transport and lifecycle management, not business logic.

---

## 13. Data Retention Policy

### 13.1 The Problem

norush stores prompt/response pairs that may contain sensitive user data. We
must avoid becoming an unbounded custodian of this data. Storage bloat is a
practical concern; liability for sensitive content is a legal one.

### 13.2 Configurable Retention

Each user can configure a retention policy that controls how long request
params and response bodies are kept. The policy applies **after successful
delivery** (or after the request reaches a terminal state if no webhook is
configured).

| Policy | Behavior |
|--------|----------|
| `on_ack` | Scrub `params` and `response` JSON immediately after the webhook receives a 2xx ACK. Metadata (IDs, timestamps, token counts, status) is retained. **Strongly encouraged for API/broker consumers.** |
| `1d` | Scrub content 1 day after delivery / terminal state. |
| `7d` | Scrub content after 7 days. **(Default for `@norush/core` library)** |
| `30d` | Scrub content after 30 days. **(Default for norush.chat)** — chat users need history visible in the UI. |
| `custom` | User-specified duration in days. |

The default is set by the **consumer of the library**, not by the end user.
norush.chat sets `30d` because chat history is the product. API/broker
consumers default to `7d` and should consider `on_ack` for sensitive workloads.

"Scrub" means replacing the `params` and `response` JSON fields with a
tombstone value (e.g., `{"scrubbed": true, "scrubbed_at": "..."}`) rather
than deleting the row. This preserves the metadata for billing, analytics,
and debugging (we can still see "request X was submitted at time Y, used
N tokens, was delivered successfully") without retaining the actual content.

### 13.3 Implementation

- A **retention worker** runs periodically (e.g., every hour) and scans for
  records past their retention window.
- The worker respects the user's configured policy from `user_settings`.
- Scrubbing is idempotent — running it twice on the same record is harmless.
- The `event_log` entries for scrubbed records are also cleaned (any `details`
  JSON that may contain prompt/response fragments).
- **Hard upper limit:** Even if a user sets a longer retention, norush enforces
  a system-wide maximum (e.g., 90 days) to bound storage growth. Configurable
  by the operator.

### 13.4 Data Model Addition

```sql
CREATE TABLE user_settings (
  user_id               TEXT PRIMARY KEY,     -- FK to users.id
  retention_policy      TEXT NOT NULL DEFAULT '7d',
                        -- 'on_ack' | '1d' | '7d' | '30d' | custom like '14d'
                        -- Default set by consuming app (7d for library, 30d for chat)
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
```

Add to `requests`:
```sql
  content_scrubbed_at   TEXT,  -- NULL until scrubbed
```

Add to `results`:
```sql
  content_scrubbed_at   TEXT,  -- NULL until scrubbed
```

---

## 14. Additional Resolved Decisions (Round 3)

### 14.1 Auth: WorkOS AuthKit

**Decision:** Use WorkOS AuthKit for norush.chat authentication.

- **Free tier:** 1M MAUs at no cost. More than sufficient for the foreseeable
  future.
- **Features included:** Email/password, social login (Google, GitHub), magic
  link, passkeys, MFA, and enterprise SSO (SAML, Entra/Azure AD, Okta) — all
  without additional code per provider.
- **Integration:** Official TypeScript SDK. Drop-in hosted UI or embedded
  components. Minimal auth code on our side.
- **Why not vanilla OAuth:** Building and maintaining OAuth flows for multiple
  providers is undifferentiated work. WorkOS gives us enterprise-grade auth
  with less code than a single OAuth integration. If we ever need to support
  a corporate customer's identity provider, it's a WorkOS config change, not
  a code change.
- **Lock-in risk:** Moderate. Auth is an integration surface, not a data
  store. If WorkOS becomes untenable, migrating to another auth provider
  (Auth0, Clerk, or self-hosted) is scoped to the auth layer. User data
  and norush state are in our own database.

### 14.2 Configuration Hierarchy

**Decision:** Three-tier configuration with clear precedence.

```
┌─────────────────────────────────────────────────┐
│  Tier 1: Environment (env vars)                  │
│  Set by: infrastructure / deployment pipeline    │
│  Examples:                                       │
│    NORUSH_MASTER_KEY     (encryption key)        │
│    DATABASE_URL          (connection string)      │
│    WORKOS_API_KEY        (auth provider)          │
│    WORKOS_CLIENT_ID                               │
│    NODE_ENV              (production/development) │
└──────────────────────┬──────────────────────────┘
                       │ overrides defaults
┌──────────────────────▼──────────────────────────┐
│  Tier 2: Operator config (file or env)           │
│  Set by: whoever deploys norush                  │
│  Examples:                                       │
│    System-wide retention cap (e.g., 90 days)     │
│    Default retention policy (7d or 30d)          │
│    Circuit breaker thresholds                    │
│    Polling strategy defaults                     │
│    Max batch sizes                               │
│    Global rate limits                            │
│    Feature flags (e.g., enable/disable failover) │
└──────────────────────┬──────────────────────────┘
                       │ overrides operator defaults
┌──────────────────────▼──────────────────────────┐
│  Tier 3: User settings (database)                │
│  Set by: end users via UI or API                 │
│  Examples:                                       │
│    Personal retention policy (within operator    │
│      cap)                                        │
│    API keys (encrypted)                          │
│    Webhook URLs + signing secrets                │
│    Spend limits                                  │
│    Preferred polling strategy                    │
└─────────────────────────────────────────────────┘
```

**Precedence rules:**
- User settings cannot exceed operator caps (e.g., user requests 120d
  retention but operator cap is 90d → clamped to 90d).
- Operator config cannot override environment settings.
- Defaults cascade: if a user hasn't set a retention policy, the operator
  default applies. If the operator hasn't set one, the library default (7d)
  applies.

Implementation: a `resolveConfig(env, operator, user)` function that merges
all three tiers with clamping. Tested with unit tests for edge cases.

### 14.3 Observability & Telemetry

**Decision:** Define hooks and metric interfaces now. Wire up implementations
later.

**Metric categories:**

| Category | Metrics | Purpose |
|----------|---------|---------|
| Volume | `requests_queued`, `batches_submitted`, `results_ingested`, `deliveries_attempted` | Throughput understanding |
| Latency | `batch_turnaround_ms` (submit → results), `delivery_latency_ms` (result → ack) | Performance tracking |
| Errors | `submission_failures`, `delivery_failures`, `circuit_breaker_trips`, `orphan_recoveries` | Reliability monitoring |
| Cost | `input_tokens_total`, `output_tokens_total`, per-model and per-user breakdowns | Billing analytics, plan pricing research |
| Size | `batch_request_count` (histogram), `request_param_bytes`, `response_bytes` | Capacity planning |

**Implementation approach:**
- Define a `TelemetryHook` interface in `@norush/core`:
  ```ts
  interface TelemetryHook {
    counter(name: string, value: number, tags?: Record<string, string>): void;
    histogram(name: string, value: number, tags?: Record<string, string>): void;
    event(name: string, data?: Record<string, unknown>): void;
  }
  ```
- Ship a `NoopTelemetry` (default) and a `ConsoleTelemetry` (for debugging).
- Instrument all key paths in the core library from day one.
- Actual Prometheus / Datadog / OpenTelemetry adapters are Phase 4 work, but
  the hooks are in place so adding them requires zero rework.
- **Anonymized stats for product analytics:** Token counts, batch sizes, and
  timing data are kept in the `event_log` and `results` metadata (which
  survives content scrubbing). This gives us the data to analyze usage
  patterns and inform pricing without retaining prompt/response content.

### 14.4 Database Adapter & Cloud Promotion

**Decision:** Abstract the storage layer behind an adapter interface so the
database engine can be swapped via connection string.

```ts
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
```

**Built-in adapters:**

| Adapter | Use case | Notes |
|---------|----------|-------|
| `MemoryStore` | Tests, ephemeral scripts | No persistence; fastest |
| `SQLiteStore` | Local dev, CLI, single-server | Uses `better-sqlite3`; single-file DB |
| `PostgresStore` | Cloud deployment, multi-instance | Uses `pg` or `postgres.js`; connection string config |

**Cloud promotion path:**
1. Develop with `SQLiteStore` locally.
2. When deploying to cloud (Azure, AWS, etc.), provision a managed PostgreSQL
   instance (e.g., Azure Database for PostgreSQL Flexible Server).
3. Set `DATABASE_URL` to the PostgreSQL connection string.
4. Run the migration tool to create the schema.
5. The application detects the connection string protocol and instantiates
   `PostgresStore` automatically.

**Why not SQLite on Azure:** SQLite requires a local filesystem with durable
write access. Azure App Service has a persistent `/home` mount that technically
works for a single instance, but it cannot support horizontal scaling (multiple
instances writing to the same SQLite file = corruption). Container services
(Container Apps, Functions) have ephemeral filesystems. For any cloud
deployment that needs reliability or scaling, PostgreSQL is the answer.

**Schema compatibility:** The SQL schema is written in standard SQL that works
on both SQLite and PostgreSQL. The few dialect differences (e.g., `TEXT` vs.
`VARCHAR`, `INTEGER` for booleans in SQLite vs. `BOOLEAN` in Postgres) are
handled by the adapter layer. Migrations are versioned and adapter-aware.

---

## 15. Remaining Open Questions

- **Deployment target for norush.chat:** Azure App Service? Azure Container
  Apps? Vercel (supports SvelteKit)? Affects the background worker strategy
  (cron vs. long-running process vs. external scheduler).
- **WebSocket for live chat updates:** Should the chat UI use WebSocket / SSE
  to push result arrival notifications in real-time, or just poll? SvelteKit
  supports both patterns.
- **Rate limiting implementation:** Token bucket? Sliding window? Per-IP or
  per-user? This matters for the broker API but not for Phase 1.
