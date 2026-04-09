-- 003_user_limits_spend.sql
-- Add current_spend_usd and created_at columns to user_limits table.
-- These support cumulative spend tracking and consistent record metadata.

ALTER TABLE user_limits
  ADD COLUMN IF NOT EXISTS current_spend_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
