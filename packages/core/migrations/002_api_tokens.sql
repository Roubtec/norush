-- 002_api_tokens.sql
-- API bearer tokens for programmatic access (REST API).

CREATE TABLE api_tokens (
  id              TEXT PRIMARY KEY,     -- ULID
  user_id         TEXT NOT NULL REFERENCES users(id),
  label           TEXT NOT NULL DEFAULT 'default',
  token_hash      TEXT NOT NULL,        -- SHA-256 hex digest of the raw token
  token_prefix    TEXT NOT NULL,        -- First 8 chars for identification (e.g. "nrsh_abc1")
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,          -- NULL = never expires
  revoked_at      TIMESTAMPTZ,          -- NULL = active; set on revocation
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
