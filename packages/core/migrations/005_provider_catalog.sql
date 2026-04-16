-- 005_provider_catalog.sql
-- Unified catalog of provider+model rows: pricing, lifecycle state, deprecation
-- dates, and recommended replacement. Refreshed from upstream provider docs
-- on a scheduled basis (see packages/web/src/lib/server/catalog/).
--
-- Only the latest row per (provider, model) is kept — lifecycle dates
-- already encode history, so historical tracking is out of scope.

CREATE TABLE IF NOT EXISTS provider_catalog (
  provider              TEXT NOT NULL,        -- 'claude' | 'openai'
  model                 TEXT NOT NULL,        -- provider's canonical model id
  display_label         TEXT NOT NULL,        -- human-readable, e.g. 'Claude Sonnet 4.6'
  input_usd_per_token   DOUBLE PRECISION,     -- NULL when provider hasn't published a price yet
  output_usd_per_token  DOUBLE PRECISION,     -- NULL when provider hasn't published a price yet
  lifecycle_state       TEXT NOT NULL,        -- 'active' | 'legacy' | 'deprecated' | 'retired'
  deprecated_at         DATE,                 -- NULL while active
  retires_at            DATE,                 -- NULL until a retirement date is announced
  replacement_model     TEXT,                 -- provider's recommended successor (NULL if none)
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model),
  CONSTRAINT provider_catalog_lifecycle_check
    CHECK (lifecycle_state IN ('active', 'legacy', 'deprecated', 'retired'))
);

-- Index for fast "list selectable models" queries (Composer).
CREATE INDEX IF NOT EXISTS idx_provider_catalog_provider_state
  ON provider_catalog(provider, lifecycle_state);
