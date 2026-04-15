# Fetch Provider Model Catalog (Rates + Lifecycle) from Upstream Sources

## Why this task exists

Two related pieces of the UI currently depend on hardcoded provider data that has already drifted from reality:

- **Rates.** The cost-savings indicator uses a static rate table in `packages/web/src/lib/savings.ts`.
  Provider pricing changes periodically, so hardcoded rates will give users inaccurate savings estimates over time.
- **Model offerings.** `packages/web/src/lib/components/Composer.svelte` hardcodes the list of selectable models.
  The list is already stale — for example `claude-3-5-haiku-20241022` was retired on 2026-02-19, and the default
  `claude-sonnet-4-20250514` was deprecated on 2026-04-14 with a retirement date of 2026-06-15.
  Submitting to a retired model will fail at the provider, and new models never appear to users.

Both pieces of information come from the same upstream provider documentation and share the same
fetch, cache, fallback, and refresh concerns. Treating them as one "provider catalog" lets us write the
HTTP plumbing, cron, and admin refresh endpoint once instead of twice, and keeps a single source of truth
per provider+model row (price plus lifecycle status).

This task replaces the static tables with a catalog fetched from each provider's published source of truth,
with a local fallback so the UI still functions when the fetch fails.

## Scope

**Included:**

- Fetch a provider model catalog on a scheduled basis (e.g. hourly or daily). For each provider+model this should capture:
  - `input_usd_per_token`, `output_usd_per_token` (pricing)
  - `lifecycle_state` — one of `active`, `legacy`, `deprecated`, `retired` (following Anthropic's vocabulary; OpenAI's `shutdown` maps to `retired`)
  - `deprecated_at`, `retires_at` (dates, nullable)
  - `replacement_model` (string, nullable — the provider's recommended successor)
  - `display_label` (human-readable name, e.g. "Claude Sonnet 4.6")
- Store the catalog in the database (`provider_catalog` table) so it survives restarts and is shared across workers
- Expose server helpers:
  - `getProviderRate(provider, model)` — returns freshest rate or hardcoded fallback
  - `listAvailableModels(provider)` — returns non-retired models ordered for UI, annotated with lifecycle state and replacement hint
- Fall back to hardcoded defaults in `$lib/savings.ts` and `$lib/models.ts` (new) when no DB row exists or the fetch fails
- Update `CostIndicator.svelte` and `+page.svelte` total-savings calculation to use server-fetched rates
- Update `Composer.svelte` to load its model list from the server catalog instead of the hardcoded `MODEL_OPTIONS` constant.
  Retired models must not be offered. Deprecated models may still be offered but should be visually marked
  (e.g. "(deprecated — use {replacement})") so users are nudged toward the replacement.
- CLI or admin endpoint to manually trigger a catalog refresh
- Unit tests for each provider's parser against captured HTML/JSON fixtures, and for the fallback path when
  the DB is empty or the upstream fetch errors

**Out of scope:**

- Per-model granularity if a provider doesn't publish it
- Historical tracking (store only the latest row per provider+model; lifecycle dates already encode history)
- Billing reconciliation against actual invoices
- Provider feature flags (vision, tool-use, context window) — these can be added in a later task if needed
- Automatic migration of already-submitted messages that referenced a now-retired model

## Context and references

**Local files:**

- `packages/web/src/lib/savings.ts` — current hardcoded rate table and fallback logic
- `packages/web/src/lib/components/CostIndicator.svelte` — per-message savings display
- `packages/web/src/lib/components/Composer.svelte:23-33` — hardcoded `MODEL_OPTIONS` constant
- `packages/web/src/routes/(app)/chat/+page.svelte` — total savings calculation
- `packages/web/src/routes/(app)/chat/+page.server.ts` — existing load function to extend

**Provider sources:**

| Provider           | Pricing source                                                                                                                             | Lifecycle source                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Anthropic (Claude) | `https://www.anthropic.com/api` pricing page; no public machine-readable API yet — scrape or use the pricing JSON embedded in the docs site | `https://platform.claude.com/docs/en/about-claude/model-deprecations` — publishes a "Model status" table with model name, current state, deprecation date, tentative retirement date, and a "Deprecation history" section naming the recommended replacement |
| OpenAI             | `https://platform.openai.com/docs/models` pricing page; consider the unofficial `https://openai.com/api/pricing` JSON if stable            | `https://platform.openai.com/docs/deprecations` — publishes shutdown dates and recommended replacements per model. Note: this page is JS-rendered, so a plain `fetch` may return an empty shell; if so, parse the embedded Next.js data payload or fall back to a manually curated list baked into the repo until a stable source appears |

Both sources are HTML that may change shape. Parsers must be defensive: if parsing fails, log a warning
and leave the existing catalog row untouched rather than overwriting it with garbage or nulls.

## Provider lifecycle vocabulary

Normalise all provider terminology to the following four states, modelled on Anthropic's published taxonomy:

- `active` — fully supported and recommended
- `legacy` — no longer receiving updates; may be deprecated in the future
- `deprecated` — still functional but not recommended; a retirement date and replacement exist
- `retired` — no longer callable; requests will fail

OpenAI uses "shutdown" instead of "retired" — treat them as equivalent.

## Target files or areas

- `packages/core/migrations/` — new migration for `provider_catalog` table (supersedes the originally-planned `provider_rates` table)
- `packages/core/src/store/` — `getProviderCatalogEntry`, `listProviderCatalog`, `upsertProviderCatalogEntry` store methods
- `packages/web/src/lib/server/catalog.ts` — fetch-and-cache helper with per-provider parsers, scheduled refresh loop
- `packages/web/src/lib/server/catalog/anthropic.ts`, `openai.ts` — per-provider parser modules (one per provider, each exporting a `fetchCatalog()` function so they can be tested in isolation)
- `packages/web/src/lib/savings.ts` — update `calculateSavings` to accept an optional rates override
- `packages/web/src/lib/models.ts` — **new**: hardcoded fallback model list (mirrors the current `MODEL_OPTIONS` shape) used when the DB is empty
- `packages/web/src/lib/components/Composer.svelte` — remove the hardcoded `MODEL_OPTIONS`, accept model options as a prop, render deprecation hints
- `packages/web/src/routes/(app)/chat/+page.server.ts` — load current catalog entries alongside messages and pass model options down to the Composer
- `packages/web/src/routes/api/admin/refresh-catalog/+server.ts` — manual refresh trigger (admin only)
- Test fixtures under `packages/web/test/fixtures/provider-catalog/` capturing representative upstream HTML/JSON responses for parser tests

## Implementation notes

- **Schema.** One unified table is preferred over two. Suggested columns:
  `provider text`, `model text`, `display_label text`, `input_usd_per_token real`, `output_usd_per_token real`,
  `lifecycle_state text`, `deprecated_at date nullable`, `retires_at date nullable`,
  `replacement_model text nullable`, `fetched_at timestamp`.
  Primary key on `(provider, model)`.
- **Fetch cadence.** Once every 24 hours is fine for production. Add a small jitter so multiple workers don't stampede the upstream pages simultaneously. Refreshes should run on startup too so a fresh deployment isn't stuck on stale fallback data.
- **Parser robustness.** Treat every upstream field as potentially missing. An entry with a valid model ID and lifecycle state but no price is still useful for the Composer; an entry with a price but no lifecycle defaults to `active`.
- **UI behaviour.** In the Composer, sort `active` first, then `legacy`, then `deprecated`; hide `retired`. When a deprecated model is selected, surface the `replacement_model` as helper text near the dropdown so users can migrate with one click.
- **Prerequisite ordering.** No other task needs to land first, but the admin refresh endpoint should reuse whatever auth gate already protects other admin routes — do not invent a new auth scheme here.
- **What not to change.** Leave the message-submission path alone; this task only changes how the model list is sourced and how savings are priced. The wire format between Composer and the submit handler (`{ provider, model, content }`) must stay the same.

## Acceptance criteria

- [ ] `provider_catalog` table exists with the columns listed above and a `(provider, model)` primary key
- [ ] Catalog is refreshed automatically (cron or worker loop) at least once every 24 hours, plus once on startup
- [ ] `CostIndicator` and total-savings display reflect fetched rates when available
- [ ] `Composer.svelte` shows models sourced from the server catalog, hides `retired` models, and visibly marks `deprecated` models with their recommended replacement
- [ ] Hardcoded fallbacks in `$lib/savings.ts` and `$lib/models.ts` are used when the DB has no row for a given provider/model
- [ ] Unit tests cover: each provider parser against captured fixtures, the fallback-when-empty path, and the "upstream returned garbage — keep prior row" path
- [ ] Manual refresh endpoint returns `204` on success and `500` with error detail on failure, and is gated behind the existing admin auth
- [ ] No message submission path or Composer wire format changes

## Validation

- `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass
- Manually trigger the admin refresh endpoint in a dev environment and confirm `provider_catalog` rows are populated
- Load `/chat` with an empty catalog and confirm the Composer still renders a usable (fallback) model list
- Select a deprecated model in the Composer and confirm the replacement hint is visible
- Confirm `claude-3-5-haiku-20241022` no longer appears in the Composer after a successful refresh

## Review plan

Reviewer should verify, in order:

1. The migration adds the unified `provider_catalog` table with the documented columns and primary key.
2. Each provider parser has a fixture-backed test, and a negative test proves parser failure does not clobber existing rows.
3. `Composer.svelte` no longer contains a hardcoded model list and correctly hides retired / flags deprecated models.
4. `savings.ts` falls back to the hardcoded table only when the DB row is missing, not silently on every call.
5. The admin refresh endpoint reuses existing auth rather than introducing a new gate.
