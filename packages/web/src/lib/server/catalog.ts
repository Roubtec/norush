/**
 * Provider catalog refresh + server helpers.
 *
 * This module owns the fetch-and-cache pipeline that keeps the
 * `provider_catalog` table in sync with each provider's published
 * pricing/lifecycle sources, and exposes the two server helpers the
 * Composer and savings code need:
 *
 *   - `getProviderRate(provider, model)`  — freshest rate or fallback.
 *   - `listAvailableModels(provider?)`    — catalog rows for the UI.
 *
 * Refresh cadence is hourly with a small random jitter so multiple web
 * workers don't stampede the upstream pages simultaneously. A refresh
 * also runs once at startup so a fresh deployment is not stuck on stale
 * fallback data.
 *
 * On parse failure (upstream returned garbage / empty) the existing
 * catalog rows are preserved — we never overwrite a good row with
 * nulls.
 */

import type { PostgresStore, ProviderCatalogEntry, ProviderName } from '@norush/core';
import { FALLBACK_MODELS, type FallbackModel } from '$lib/models.js';
import type { RatePair, RatesOverride } from '$lib/savings.js';
import type { ParsedCatalogEntry } from './catalog/types.js';
import { fetchAnthropicCatalog } from './catalog/anthropic.js';
import { fetchOpenAICatalog } from './catalog/openai.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Base interval between scheduled refreshes. Once an hour is plenty — the
 *  upstream pages update on human time scales, not machine time scales. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Random jitter added to the interval so concurrent workers stagger their
 *  upstream fetches instead of arriving together. */
const REFRESH_JITTER_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single provider's fetch entry point. */
export interface CatalogSource {
  provider: ProviderName;
  fetchCatalog(fetchImpl?: typeof fetch): Promise<ParsedCatalogEntry[]>;
}

/** One row as rendered to the Composer / savings UI. */
export interface AvailableModel {
  provider: ProviderName;
  model: string;
  displayLabel: string;
  lifecycleState: ProviderCatalogEntry['lifecycleState'];
  deprecatedAt: string | null;
  retiresAt: string | null;
  replacementModel: string | null;
  inputUsdPerToken: number | null;
  outputUsdPerToken: number | null;
}

// ---------------------------------------------------------------------------
// Default sources — wired to the live provider modules.
// ---------------------------------------------------------------------------

export const DEFAULT_CATALOG_SOURCES: CatalogSource[] = [
  { provider: 'claude', fetchCatalog: fetchAnthropicCatalog },
  { provider: 'openai', fetchCatalog: fetchOpenAICatalog },
];

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export interface RefreshResult {
  provider: ProviderName;
  fetched: number;
  upserted: number;
  /** Human-readable reason when the refresh skipped writing rows. */
  skipped?: string;
}

/**
 * Run one refresh cycle across all provided sources. Writes to the store
 * are per-row `upsert` calls; parse failures (empty source result) are
 * logged and leave existing rows untouched.
 */
export async function refreshProviderCatalog(
  store: Pick<PostgresStore, 'upsertProviderCatalogEntry'>,
  sources: CatalogSource[] = DEFAULT_CATALOG_SOURCES,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  for (const source of sources) {
    try {
      const entries = await source.fetchCatalog(options.fetchImpl);
      if (entries.length === 0) {
        console.warn(
          `[catalog] ${source.provider}: parser returned 0 entries, leaving existing rows untouched`,
        );
        results.push({
          provider: source.provider,
          fetched: 0,
          upserted: 0,
          skipped: 'empty_parse',
        });
        continue;
      }

      let upserted = 0;
      for (const entry of entries) {
        await store.upsertProviderCatalogEntry({
          provider: entry.provider,
          model: entry.model,
          displayLabel: entry.displayLabel,
          inputUsdPerToken: entry.inputUsdPerToken,
          outputUsdPerToken: entry.outputUsdPerToken,
          lifecycleState: entry.lifecycleState,
          deprecatedAt: entry.deprecatedAt,
          retiresAt: entry.retiresAt,
          replacementModel: entry.replacementModel,
        });
        upserted += 1;
      }
      results.push({ provider: source.provider, fetched: entries.length, upserted });
    } catch (err) {
      console.error(`[catalog] ${source.provider} refresh failed:`, err);
      results.push({
        provider: source.provider,
        fetched: 0,
        upserted: 0,
        skipped: err instanceof Error ? `error:${err.message}` : 'error',
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scheduled refresh loop
// ---------------------------------------------------------------------------

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshStarted = false;

function scheduleNext(
  store: Pick<PostgresStore, 'upsertProviderCatalogEntry'>,
  sources: CatalogSource[],
): void {
  const delay = REFRESH_INTERVAL_MS + Math.floor(Math.random() * REFRESH_JITTER_MS);
  refreshTimer = setTimeout(() => {
    void (async () => {
      try {
        await refreshProviderCatalog(store, sources);
      } catch (err) {
        console.error('[catalog] scheduled refresh threw:', err);
      } finally {
        scheduleNext(store, sources);
      }
    })();
  }, delay);
  // Don't keep the event loop alive just for catalog refresh.
  if (typeof refreshTimer === 'object' && refreshTimer && 'unref' in refreshTimer) {
    (refreshTimer as { unref: () => void }).unref();
  }
}

/**
 * Kick off the scheduled refresh loop. Idempotent — subsequent calls are
 * no-ops. Runs one refresh immediately so a fresh deployment doesn't sit
 * on stale fallback data until the first interval fires.
 */
export function startCatalogRefresh(
  store: Pick<PostgresStore, 'upsertProviderCatalogEntry'>,
  sources: CatalogSource[] = DEFAULT_CATALOG_SOURCES,
): void {
  if (refreshStarted) return;
  refreshStarted = true;

  // Immediate refresh (fire-and-forget — don't block startup).
  void (async () => {
    try {
      await refreshProviderCatalog(store, sources);
    } catch (err) {
      console.error('[catalog] startup refresh failed:', err);
    }
  })();

  scheduleNext(store, sources);
}

/** Exposed for tests. */
export function stopCatalogRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  refreshStarted = false;
}

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

/**
 * Look up the freshest rate for a (provider, model) pair. Falls back to
 * the hardcoded seed when the DB has no row. Returns null if neither
 * source knows about the model.
 */
export async function getProviderRate(
  store: Pick<PostgresStore, 'getProviderCatalogEntry'>,
  provider: ProviderName,
  model: string,
): Promise<RatePair | null> {
  const live = await store.getProviderCatalogEntry(provider, model);
  if (live && live.inputUsdPerToken != null && live.outputUsdPerToken != null) {
    return { input: live.inputUsdPerToken, output: live.outputUsdPerToken };
  }
  const seed = FALLBACK_MODELS.find((m) => m.provider === provider && m.model === model);
  if (seed && seed.inputUsdPerToken != null && seed.outputUsdPerToken != null) {
    return { input: seed.inputUsdPerToken, output: seed.outputUsdPerToken };
  }
  return null;
}

/**
 * List models available for the Composer, annotated with lifecycle state
 * and replacement hint.
 *
 * The Composer filters the result to `active` + `legacy` — see
 * `Composer.svelte` — so any `deprecated` / `retired` rows that pass
 * through here are intended for non-Composer surfaces (e.g. historical
 * message views with "this model has since been deprecated" labels).
 *
 * Order: `active` first (display-label-sorted), then `legacy`, then
 * `deprecated`, then `retired`. That keeps the Composer's sensible
 * options at the top for free.
 *
 * When the DB has rows for a given provider, they win. Models that only
 * appear in the hardcoded `FALLBACK_MODELS` seed are backfilled after
 * the DB rows so a fresh deployment still shows *something*.
 */
export async function listAvailableModels(
  store: Pick<PostgresStore, 'listProviderCatalog'>,
  provider?: ProviderName,
): Promise<AvailableModel[]> {
  const live = await store.listProviderCatalog(provider);
  const byKey = new Map<string, AvailableModel>();

  for (const row of live) {
    byKey.set(`${row.provider}::${row.model}`, {
      provider: row.provider,
      model: row.model,
      displayLabel: row.displayLabel,
      lifecycleState: row.lifecycleState,
      deprecatedAt: row.deprecatedAt ? row.deprecatedAt.toISOString().slice(0, 10) : null,
      retiresAt: row.retiresAt ? row.retiresAt.toISOString().slice(0, 10) : null,
      replacementModel: row.replacementModel,
      inputUsdPerToken: row.inputUsdPerToken,
      outputUsdPerToken: row.outputUsdPerToken,
    });
  }

  for (const seed of FALLBACK_MODELS) {
    if (provider && seed.provider !== provider) continue;
    const key = `${seed.provider}::${seed.model}`;
    if (byKey.has(key)) continue;
    byKey.set(key, fallbackToAvailable(seed));
  }

  return [...byKey.values()].sort(compareForUi);
}

function fallbackToAvailable(seed: FallbackModel): AvailableModel {
  return {
    provider: seed.provider,
    model: seed.model,
    displayLabel: seed.displayLabel,
    lifecycleState: seed.lifecycleState,
    deprecatedAt: seed.deprecatedAt,
    retiresAt: seed.retiresAt,
    replacementModel: seed.replacementModel,
    inputUsdPerToken: seed.inputUsdPerToken,
    outputUsdPerToken: seed.outputUsdPerToken,
  };
}

const LIFECYCLE_ORDER: Record<ProviderCatalogEntry['lifecycleState'], number> = {
  active: 0,
  legacy: 1,
  deprecated: 2,
  retired: 3,
};

function compareForUi(a: AvailableModel, b: AvailableModel): number {
  if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
  const la = LIFECYCLE_ORDER[a.lifecycleState];
  const lb = LIFECYCLE_ORDER[b.lifecycleState];
  if (la !== lb) return la - lb;
  return a.displayLabel.localeCompare(b.displayLabel);
}

// ---------------------------------------------------------------------------
// RatesOverride factory
// ---------------------------------------------------------------------------

/**
 * Build a `RatesOverride` object from an already-loaded list of models,
 * suitable for passing through to `calculateSavings()`. Used by the chat
 * page load so the client renders the same per-model rate the server
 * used.
 */
export function buildRatesOverride(models: AvailableModel[]): RatesOverride {
  const index = new Map<string, RatePair>();
  for (const m of models) {
    if (m.inputUsdPerToken != null && m.outputUsdPerToken != null) {
      index.set(`${m.provider}::${m.model}`, {
        input: m.inputUsdPerToken,
        output: m.outputUsdPerToken,
      });
    }
  }
  return {
    getRate(provider: string, model: string): RatePair | null {
      return index.get(`${provider}::${model}`) ?? null;
    },
  };
}
