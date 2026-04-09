# Fetch Live API Rates from Provider Sources

## Why this task exists

The cost savings indicator currently uses hardcoded rate tables in `packages/web/src/lib/savings.ts`.
Provider pricing changes periodically, so hardcoded rates will drift and give users inaccurate savings estimates.
This task replaces the static table with rates fetched from each provider's published source of truth, with a
local fallback so the UI still functions when the fetch fails.

## Scope

**Included:**
- Fetch current model pricing from provider APIs/pages on a scheduled basis (e.g. hourly or daily)
- Store fetched rates in the database (`provider_rates` table) so they survive restarts and are shared across workers
- Expose a server helper that returns the freshest available rates for a given provider + model
- Fall back to the hardcoded rates in `$lib/savings.ts` when no DB row exists or the fetch fails
- Update `CostIndicator.svelte` and `+page.svelte` total-savings calculation to use server-fetched rates
- CLI or admin endpoint to manually trigger a rate refresh

**Out of scope:**
- Per-model granularity if a provider doesn't publish per-model rates via a machine-readable API
- Historical rate tracking (store only the latest rate per provider+model)
- Billing reconciliation against actual invoices

## Context and references

- `packages/web/src/lib/savings.ts` — current hardcoded rate table and fallback logic
- `packages/web/src/lib/components/CostIndicator.svelte` — per-message savings display
- `packages/web/src/routes/(app)/chat/+page.svelte` — total savings calculation

## Provider rate sources

| Provider | Source |
|----------|--------|
| Anthropic (Claude) | `https://www.anthropic.com/api` pricing page; no public machine-readable API yet — scrape or use the pricing JSON embedded in the docs site |
| OpenAI | `https://platform.openai.com/docs/models` pricing page; consider the unofficial `https://openai.com/api/pricing` JSON if stable |

## Target files or areas

- `packages/core/migrations/` — new migration for `provider_rates` table
- `packages/core/src/store/` — `getProviderRate`, `upsertProviderRate` store methods
- `packages/web/src/lib/server/rates.ts` — fetch-and-cache helper, scheduled refresh logic
- `packages/web/src/lib/savings.ts` — update `calculateSavings` to accept an optional rates override
- `packages/web/src/routes/(app)/chat/+page.server.ts` — load current rates alongside messages
- `packages/web/src/routes/api/admin/refresh-rates/+server.ts` — manual refresh trigger (admin only)

## Acceptance criteria

- [ ] `provider_rates` table exists with columns: `provider`, `model`, `input_usd_per_token`, `output_usd_per_token`, `fetched_at`
- [ ] Rates are refreshed automatically (cron or worker loop) at least once every 24 hours
- [ ] CostIndicator and total-savings display reflect fetched rates when available
- [ ] Hardcoded fallback in `$lib/savings.ts` is used when the DB has no row for a given provider/model
- [ ] Unit tests for the fetch helper (mock HTTP responses) and fallback behaviour
- [ ] Manual refresh endpoint returns `204` on success, `500` with error detail on failure
