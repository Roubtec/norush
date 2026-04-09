-- 001_initial_schema.sql
-- Full norush database schema from PLAN.md Section 4.1.

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,     -- ULID
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id                    TEXT PRIMARY KEY,     -- ULID
  user_id               TEXT NOT NULL REFERENCES users(id),
  provider              TEXT NOT NULL,        -- 'claude' | 'openai'
  label                 TEXT NOT NULL,        -- 'primary', 'backup', etc.
  api_key_encrypted     BYTEA NOT NULL,
                        -- Self-contained blob: 1-byte version || 12-byte IV
                        -- || ciphertext || 16-byte GCM auth tag.
                        -- Encrypted with AES-256-GCM using NORUSH_MASTER_KEY.
  priority              INTEGER NOT NULL DEFAULT 0,  -- lower = tried first
  failover_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_limits (
  user_id               TEXT PRIMARY KEY REFERENCES users(id),
  max_requests_per_hour INTEGER,              -- NULL = unlimited
  max_tokens_per_day    INTEGER,              -- NULL = unlimited
  hard_spend_limit_usd  NUMERIC(10,2),        -- NULL = unlimited
  current_period_requests INTEGER NOT NULL DEFAULT 0,
  current_period_tokens   INTEGER NOT NULL DEFAULT 0,
  period_reset_at       TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id               TEXT PRIMARY KEY REFERENCES users(id),
  retention_policy      TEXT NOT NULL DEFAULT '7d',
                        -- 'on_ack' | '1d' | '7d' | '30d' | custom e.g. '14d'
                        -- Default set by consuming app (7d for library, 30d for chat)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
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

CREATE TABLE IF NOT EXISTS batches (
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

CREATE TABLE IF NOT EXISTS results (
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

CREATE TABLE IF NOT EXISTS event_log (
  id                    TEXT PRIMARY KEY,     -- ULID
  entity_type           TEXT NOT NULL,        -- 'batch' | 'request' | 'result'
  entity_id             TEXT NOT NULL,
  event                 TEXT NOT NULL,        -- 'submitted', 'orphan_recovered',
                                              -- 'circuit_breaker_tripped', etc.
  details               JSONB,               -- scrubbed alongside parent record
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_batch_id ON requests(batch_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);
CREATE INDEX IF NOT EXISTS idx_batches_updated_at ON batches(updated_at);
CREATE INDEX IF NOT EXISTS idx_results_delivery_status ON results(delivery_status)
  WHERE delivery_status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_results_content_scrub ON results(content_scrubbed_at)
  WHERE content_scrubbed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_log_entity ON event_log(entity_type, entity_id);

-- Deferred FK: requests.batch_id → batches(id). Declared after both tables
-- exist because requests is defined before batches in this file.
ALTER TABLE requests
  ADD CONSTRAINT fk_requests_batch_id
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL;
