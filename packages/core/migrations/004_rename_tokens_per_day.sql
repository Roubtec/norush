-- 004_rename_tokens_per_day.sql
-- Rename max_tokens_per_day to max_tokens_per_period for period-agnostic naming.
-- The limit was always period-scoped; the column name is now consistent with the
-- other period-based counters and makes it easier to adjust period duration later.

ALTER TABLE user_limits
  RENAME COLUMN max_tokens_per_day TO max_tokens_per_period;
