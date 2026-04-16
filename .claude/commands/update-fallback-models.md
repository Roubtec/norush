---
description: Refresh the hardcoded fallback model catalog and pricing tables from the latest provider documentation. Use when a provider ships a new model, deprecates one, or changes prices.
disable-model-invocation: true
argument-hint: [openai-markup-or-path] [anthropic-markup-or-path]
---

Refresh the fallback model list and the provider pricing tables so they
match the latest public documentation.

These tables are the source of truth whenever the scheduled
`provider_catalog` refresh is empty or fails, so an out-of-date entry is
a user-visible bug — a retired model could still appear in the Composer
or a price could disqualify a cost estimate.

## Inputs you may receive

The user will usually invoke this command when they have fresh docs in
hand. Arguments can be supplied in any of these shapes — handle all of
them:

- **Inline markup** — a block of Markdown or HTML pasted directly into
  the prompt (typical for OpenAI, whose pricing and model pages are
  client-side rendered and cannot be fetched with `WebFetch`).
- **File reference** — a path like `./tmp/openai-pricing.md` or an `@`-
  reference. Read the file with the `Read` tool.
- **URL** — only for Anthropic, whose docs are server-rendered. Use
  `WebFetch` against `platform.claude.com/docs/...` pages.
- **Nothing** — fall back to fetching the Anthropic overview and
  deprecation pages, and ask the user for the OpenAI markup before
  touching OpenAI entries.

If the user does not specify a provider, assume they want both refreshed
and ask for whatever markup you are missing.

## Target files

All three must stay consistent with each other — a model that appears
in `FALLBACK_MODELS` must also have a pricing row in the matching
provider catalog module.

1. `packages/web/src/lib/models.ts`
   The hardcoded `FALLBACK_MODELS` list used by the Composer when the
   DB catalog is empty. Contains lifecycle metadata, display labels,
   and per-token prices for both providers.

2. `packages/web/src/lib/server/catalog/anthropic.ts`
   The `ANTHROPIC_PRICING` map used by the scheduled deprecation-page
   parser. Keys are API IDs (both the alias form like
   `claude-haiku-4-5` and the dated form like `claude-haiku-4-5-20251001`
   when Anthropic publishes both).

3. `packages/web/src/lib/server/catalog/openai.ts`
   The `OPENAI_PRICING` map used when the `__NEXT_DATA__` payload
   parser succeeds. Batch/flex-tier prices (= 50% of standard list)
   because NoRush submits exclusively via the Batch API.

## Authoritative sources

- **Anthropic models:** `https://platform.claude.com/docs/en/about-claude/models/overview`
- **Anthropic deprecations:** `https://platform.claude.com/docs/en/about-claude/model-deprecations`
- **OpenAI models:** `https://platform.openai.com/docs/models` (JS-rendered — expect markup from the user)
- **OpenAI pricing:** `https://developers.openai.com/api/docs/pricing` — use the **Batch** tab (JS-rendered — expect markup from the user)
- **OpenAI deprecations:** `https://platform.openai.com/docs/deprecations` (JS-rendered — expect markup from the user)

Record the date the markup was captured in the file-header comment so a
future reader can tell whether a 3-month-old entry is still fresh.

## Lifecycle vocabulary

The internal states in `ProviderLifecycleState` are modelled on
Anthropic's taxonomy, which the user-facing UI already depends on:

- `active` — fully supported, rendered in the Composer.
- `legacy` — still callable but superseded, rendered in the Composer
  with a "legacy" marker and a `replacementModel` pointer.
- `deprecated` — hidden from the Composer; kept so historical requests
  render their cost and the "retiring soon" admin banner still lights
  up. Must have `deprecatedAt` and `retiresAt` dates.
- `retired` — never callable again; kept only so historical cost columns
  still resolve a price. Set `deprecatedAt`/`retiresAt` from whatever
  the source reports.

Map provider-specific labels before writing:

- OpenAI's "shutdown" and "deprecated" both land in our `retired` and
  `deprecated` states respectively.
- Treat OpenAI's "legacy" banner the same as Anthropic's `legacy`.

## Procedure

Run these steps in order. Do not skip the verification pass at the end
— a typo in a price rate is silently expensive.

1. **Inventory what's there.** Read the three target files. Note every
   model currently listed, its lifecycle state, and its price. A diff
   at the end should show a minimal, auditable change — not a full
   rewrite.

2. **Parse the supplied markup.** For each provider:
   - From the models/overview markup, collect every model id, its
     display label, its context window (for reference — not stored),
     and its per-MTok pricing.
   - From the deprecations/lifecycle markup, collect state, deprecation
     date, retirement date, and recommended replacement.
   - Convert MTok prices to per-token rates using `X / 1_000_000`.
     Keep the original division expression in source (e.g. `5.0 /
     1_000_000`) so the raw dollar figure stays readable in reviews.
   - Prefer the API alias (`claude-opus-4-7`) over the dated snapshot
     (`claude-opus-4-7-20260416`) for active models, matching the
     pattern in the current file. Legacy/deprecated/retired rows use
     the dated snapshot so callers can pin to a specific release.

3. **Reconcile.** For each existing row:
   - If the source still lists it → update any fields that drifted
     (state, price, replacement pointer).
   - If the source marks it deprecated/retired → move the row to the
     correct section in the file and backfill the date/replacement
     fields.
   - If the row no longer appears anywhere in the source → leave it in
     place only if it's `deprecated` or `retired` (we keep those for
     historical-cost display); otherwise remove it.
   - Add any new models from the source that are missing locally.
   - Update every `replacementModel` pointer that names a now-demoted
     model so it points to the current frontier successor.

4. **Preserve invariants.**
   - `FALLBACK_MODELS` must be frozen (`Object.freeze([...])`).
   - Every model in `FALLBACK_MODELS` has a matching entry in its
     provider's pricing map.
   - Every `replacementModel` points at a model id that also appears
     in `FALLBACK_MODELS` (or in the corresponding pricing map for
     catalog-only ids).
   - Section comments (`// Active frontier`, `// Legacy`, …) stay in
     sync with the lifecycle state of the rows beneath them.

5. **Refresh the header comments** in each touched file:
   - `models.ts`: update the `Current-as-of-YYYY-MM-DD` line to
     today's date and point at the authoritative URL you used.
   - `openai.ts`: update the `Source: ...` comment with the capture
     date and the pricing tier (batch/flex).
   - `anthropic.ts`: the parser comment already names the page — only
     update if the URL or column order changed.

6. **Run the verification checklist** from `AGENTS.md`:
   ```bash
   pnpm format
   pnpm lint
   pnpm typecheck
   pnpm test
   ```
   The existing suite covers the catalog parsers (`test/catalog/*`) and
   the fallback list surface (`test/chat/cost-indicator.test.ts`,
   `test/chat/messages-api.test.ts`). If any of those fail because of
   a model id rename, update the tests with the same care as the
   source — never paper over the failure by pinning to a stale id.

7. **Diff review.** Before committing, re-read the diff and confirm
   every price change is explained by the source markup. A stray `0.8`
   vs `0.08` is the kind of bug this command exists to catch.

## If a source is unavailable

- If the user cannot supply OpenAI markup, **do not invent prices**.
  Leave OpenAI rows untouched, update only Anthropic, and call out in
  the commit message that OpenAI was skipped this round.
- If Anthropic's URLs return a shape the parser doesn't understand,
  fix the parser (`packages/web/src/lib/server/catalog/anthropic.ts`)
  rather than working around it in the fallback list — the fallback
  list is the belt, the scheduled refresh is the suspenders.

## Commit

Create a single commit whose message names every model whose state or
price changed. Example shape:

```
refresh fallback catalog (2026-MM-DD snapshot)

- add claude-opus-4-8 as active frontier
- demote claude-opus-4-7 to legacy; retarget 4.1/4.5/4.6 replacement
- update gpt-5.4 input price $1.25 → $1.10 (batch tier)
- OpenAI section skipped: no fresh markup supplied
```

Arguments follow.

$ARGUMENTS
