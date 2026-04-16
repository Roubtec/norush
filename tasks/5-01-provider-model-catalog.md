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
  **Neither `retired` nor `deprecated` models should be offered for selection.** Because NoRush submits batches
  for delayed execution, a job submitted against a deprecated model may not run until after that model is retired
  and will then fail at the provider. Offering only `active` (and `legacy`) models in the Composer avoids that
  failure window entirely. The catalog still stores `deprecated_at`, `retires_at`, and `replacement_model` so
  we can revisit this UI decision later (e.g. surface a "previously used" picker or in-flight-job warnings)
  without re-scraping.
- CLI or admin endpoint to manually trigger a catalog refresh
- **Execution-time lifecycle preflight** in the batch submission path (see dedicated section below) —
  catch requests whose target model was active at submission time but became retired before the batch runs,
  and short-circuit queued-but-not-yet-submitted retired-model requests to `failed_final` without burning
  provider calls or retry budget
- Unit tests for each provider's parser against captured HTML/JSON fixtures, and for the fallback path when
  the DB is empty or the upstream fetch errors

**Out of scope:**

- Per-model granularity if a provider doesn't publish it
- Historical tracking (store only the latest row per provider+model; lifecycle dates already encode history)
- Billing reconciliation against actual invoices
- Provider feature flags (vision, tool-use, context window) — these can be added in a later task if needed
- **Automatic migration of in-flight requests to a replacement model.** Anthropic's public deprecation policy
  commits to "at least 60 days notice" between deprecation and retirement, and observed history confirms it
  (Sonnet 4 got 62 days, Haiku 3.5 got 62 days, Haiku 3 got 60). NoRush's longest pipeline — a 24h batch
  plus its retry budget — fits comfortably inside that window with ~50 days of margin, so a request submitted
  against an active model cannot realistically reach retirement before execution. The execution-time preflight
  (see below) is sufficient defense-in-depth for the exceptional case of an unannounced short-notice shutdown;
  silent rewriting of the user's chosen model to a "replacement" is out of scope because it changes the
  semantics of the submission without consent. **The delivered code for the preflight must carry a comment
  that names the 60-day policy and explains why we chose preflight-and-fail over silent migration**, so a
  future reviewer revisiting this area has the reasoning in-situ rather than having to dig up this task.

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

## Execution-time lifecycle preflight

**Why it's needed.** Neither Anthropic nor OpenAI exposes a machine-readable "this model is retired" signal
that we can distinguish from ordinary not-found / typo errors. Anthropic returns a prose message inside an
`invalid_request_error`; OpenAI returns a generic 404 / `model_not_found` that also covers mistyped or
restricted model names. Without the catalog we can't classify retirement in principle, so the catalog is the
only place a reliable lifecycle gate can live.

**Today's behaviour (the bug we're fixing).** A request targeting a retired model (e.g. the currently
hardcoded `claude-3-5-haiku-20241022`) is submitted to the provider, comes back `errored` per-request, and is
re-queued by `Repackager` (`packages/core/src/engine/repackager.ts`) up to `maxRetries` times. Every attempt
burns a provider call and retry budget for a request that can never succeed.

**What to add.** In the batch submission path — `BatchManager.flush` / `submitBatch` in
`packages/core/src/engine/batch-manager.ts` — before handing a group of requests to the provider adapter,
look up each request's `(provider, model)` in `provider_catalog` using the `getProviderCatalogEntry` store
helper introduced above. For any request whose entry has `lifecycle_state = 'retired'`:

- Do **not** include the request in the batch sent to the provider.
- Transition the request's status directly to `failed_final` (bypass the normal failed → repackager → retry loop).
- Record a structured error carrying `{ reason: 'model_retired', model, retired_at, replacement_model }` so the
  UI layer can surface a clear explanation rather than "provider returned an error".
- Emit a telemetry event so ops can see when this fires at volume.

Requests with `lifecycle_state = 'deprecated'` should **still** be submitted (the Composer already filters them
out of new submissions, and an already-queued deprecated-but-not-retired request is still callable). Models
absent from the catalog should also be submitted — the catalog may lag and we don't want to false-positive
against a just-released model.

**Why preflight rather than error-classification after the fact.** See the matching out-of-scope bullet:
providers don't expose a clean "retired" error code, so a post-hoc classifier would have to string-match
message prose and would drift as providers change their wording. Preflight is the stable gate.

**Code comment requirement.** The preflight function must include a short comment block naming the Anthropic
60-day notice commitment and explaining why we gate here instead of silently rewriting the model choice. This
is explicitly called out so future reviewers don't re-litigate the decision from first principles.

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
- `packages/core/src/engine/batch-manager.ts` — add the execution-time preflight inside `flush` / `submitBatch` before the provider adapter is called; the preflight uses the new `getProviderCatalogEntry` store helper and must carry the in-code comment described in the Execution-time lifecycle preflight section
- Test fixtures under `packages/web/test/fixtures/provider-catalog/` capturing representative upstream HTML/JSON responses for parser tests
- `packages/core/src/__tests__/engine/batch-manager.test.ts` (or a new sibling file) — tests for the preflight covering: `retired` → `failed_final` without submission, `deprecated` → submitted normally, unknown model → submitted normally, `active` → submitted normally

## Implementation notes

- **Schema.** One unified table is preferred over two. Suggested columns:
  `provider text`, `model text`, `display_label text`, `input_usd_per_token real`, `output_usd_per_token real`,
  `lifecycle_state text`, `deprecated_at date nullable`, `retires_at date nullable`,
  `replacement_model text nullable`, `fetched_at timestamp`.
  Primary key on `(provider, model)`.
- **Fetch cadence.** Once every 24 hours is fine for production. Add a small jitter so multiple workers don't stampede the upstream pages simultaneously. Refreshes should run on startup too so a fresh deployment isn't stuck on stale fallback data.
- **Parser robustness.** Treat every upstream field as potentially missing. An entry with a valid model ID and lifecycle state but no price is still useful for the Composer; an entry with a price but no lifecycle defaults to `active`.
- **UI behaviour.** In the Composer, offer only `active` and `legacy` models, sorted `active` first. Hide both `deprecated` and `retired` — see the Scope section for rationale. Lifecycle metadata still needs to be loaded into the page context so other surfaces (e.g. historical message views, future admin pages) can render "this model has since been deprecated" annotations without refetching.
- **Prerequisite ordering.** No other task needs to land first, but the admin refresh endpoint should reuse whatever auth gate already protects other admin routes — do not invent a new auth scheme here.
- **What not to change.** Leave the message-submission path alone; this task only changes how the model list is sourced and how savings are priced. The wire format between Composer and the submit handler (`{ provider, model, content }`) must stay the same.

## Acceptance criteria

- [ ] `provider_catalog` table exists with the columns listed above and a `(provider, model)` primary key
- [ ] Catalog is refreshed automatically (cron or worker loop) at least once every 24 hours, plus once on startup
- [ ] `CostIndicator` and total-savings display reflect fetched rates when available
- [ ] `Composer.svelte` shows models sourced from the server catalog and offers only `active` and `legacy` models — `deprecated` and `retired` models are not selectable
- [ ] Deprecation metadata (`deprecated_at`, `retires_at`, `replacement_model`) is still persisted and available via `listProviderCatalog` for future UI use, even though the Composer does not render it today
- [ ] Hardcoded fallbacks in `$lib/savings.ts` and `$lib/models.ts` are used when the DB has no row for a given provider/model
- [ ] Unit tests cover: each provider parser against captured fixtures, the fallback-when-empty path, and the "upstream returned garbage — keep prior row" path
- [ ] Manual refresh endpoint returns `204` on success and `500` with error detail on failure, and is gated behind the existing admin auth
- [ ] Execution-time preflight in `BatchManager` short-circuits requests whose model is `retired` directly to `failed_final` with a structured `{ reason: 'model_retired', ... }` error, without sending them to the provider or enqueuing them for repackager retries
- [ ] `deprecated`, unknown, and `active` models are all still submitted normally by the preflight (proven by unit tests)
- [ ] The preflight carries an in-code comment naming the Anthropic 60-day notice commitment and the "preflight rather than silent migration" rationale
- [ ] Composer wire format (`{ provider, model, content }`) is unchanged and the broader submission path is otherwise untouched

## Validation

- `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass
- Manually trigger the admin refresh endpoint in a dev environment and confirm `provider_catalog` rows are populated
- Load `/chat` with an empty catalog and confirm the Composer still renders a usable (fallback) model list
- Confirm that after a successful refresh the Composer offers only `active` / `legacy` models — in particular, neither `claude-3-5-haiku-20241022` (retired) nor `claude-sonnet-4-20250514` (deprecated 2026-04-14) should appear
- Query the `provider_catalog` table directly and confirm the hidden deprecated/retired rows are still present with their lifecycle metadata
- Manually queue a request against a known-retired model (e.g. seed the catalog with a retired entry in a dev DB) and confirm: the next `BatchManager.flush` moves the request directly to `failed_final`, no provider call is made, and the request's error payload includes `reason: 'model_retired'` with the replacement model

## Review plan

Reviewer should verify, in order:

1. The migration adds the unified `provider_catalog` table with the documented columns and primary key.
2. Each provider parser has a fixture-backed test, and a negative test proves parser failure does not clobber existing rows.
3. `Composer.svelte` no longer contains a hardcoded model list and filters out both `deprecated` and `retired` models, while the underlying catalog still stores them with full lifecycle metadata.
4. `savings.ts` falls back to the hardcoded table only when the DB row is missing, not silently on every call.
5. The admin refresh endpoint reuses existing auth rather than introducing a new gate.
6. The `BatchManager` preflight: check the in-code comment is present and names the 60-day commitment, confirm retired-model requests skip the provider adapter entirely and go straight to `failed_final` with a structured reason, and confirm the deprecated / unknown / active paths are covered by tests.
