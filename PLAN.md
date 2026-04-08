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

#### Result Router
- When results arrive, matches them back to `norush_id` via `custom_id`.
- Invokes the configured delivery mechanism per-request:
  - **Callback function** (in-process).
  - **Webhook POST** (for remote consumers).
  - **Event emitter** (for pub/sub patterns).
  - **Storage write** (persist to DB/file for later retrieval).

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

## 8. Data Model (Draft)

```sql
-- A single prompt/request submitted by a consumer
CREATE TABLE requests (
  id            TEXT PRIMARY KEY,  -- norush_id (ULID or UUID)
  external_id   TEXT,              -- custom_id sent to provider
  provider      TEXT NOT NULL,     -- 'claude' | 'openai'
  model         TEXT NOT NULL,     -- e.g. 'claude-sonnet-4-6'
  params        JSON NOT NULL,     -- full request params
  status        TEXT NOT NULL DEFAULT 'queued',
                -- queued | batched | processing | completed | failed | expired
  batch_id      TEXT,              -- FK to batches.id
  user_id       TEXT,              -- for multi-tenant mode
  callback_url  TEXT,              -- optional webhook
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- A batch submitted to a provider
CREATE TABLE batches (
  id                TEXT PRIMARY KEY,  -- internal batch ID
  provider          TEXT NOT NULL,
  provider_batch_id TEXT,              -- ID returned by provider
  status            TEXT NOT NULL DEFAULT 'pending',
                    -- pending | submitted | processing | ended | expired | cancelled
  request_count     INTEGER NOT NULL DEFAULT 0,
  submitted_at      TEXT,
  ended_at          TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Responses received from providers
CREATE TABLE results (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL,      -- FK to requests.id
  response      JSON NOT NULL,      -- full provider response
  stop_reason   TEXT,               -- end_turn, max_tokens, etc.
  input_tokens  INTEGER,
  output_tokens INTEGER,
  delivered     INTEGER NOT NULL DEFAULT 0,  -- 0 = pending, 1 = delivered
  delivered_at  TEXT,
  created_at    TEXT NOT NULL
);
```

---

## 9. Open Questions

- **Multi-user key isolation**: When batching requests from multiple users, can
  we combine them into one provider batch if they use the same API key? Or must
  each user's requests be a separate batch? (Answer: separate batches per API
  key, since the key determines billing.)
- **Webhook security**: HMAC signing of webhook payloads? Shared secret per
  user endpoint?
- **Streaming results**: Claude's SDK has `results()` streaming. Should norush
  support streaming partial batch results as they complete, or wait for the
  full batch?
- **Idempotency**: If the process crashes after submitting a batch but before
  persisting the batch ID, we might double-submit. Mitigation: write batch
  record before submission, update with provider ID after.
- **Rate of polling**: Adaptive polling? Start frequent, back off as time
  passes?
