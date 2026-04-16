/**
 * Tests for the refresh pipeline and the Composer/savings server helpers.
 *
 * Uses the in-memory Store from @norush/core so we exercise the same
 * interface the production PostgresStore satisfies without needing a
 * live database.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '@norush/core';
import type { PostgresStore } from '@norush/core';
import {
  refreshProviderCatalog,
  listAvailableModels,
  getProviderRate,
  buildRatesOverride,
  type CatalogSource,
} from '$lib/server/catalog.js';
import type { ParsedCatalogEntry } from '$lib/server/catalog/types.js';
import { calculateSavings } from '$lib/savings.js';

function asPgStore(store: MemoryStore): PostgresStore {
  // MemoryStore satisfies the Store interface; the helpers only use the
  // ProviderCatalog subset, so this structural cast is safe for tests.
  return store as unknown as PostgresStore;
}

const ANTHROPIC_SOURCE: CatalogSource = {
  provider: 'claude',
  async fetchCatalog(): Promise<ParsedCatalogEntry[]> {
    return [
      {
        provider: 'claude',
        model: 'claude-sonnet-4-5-20250929',
        displayLabel: 'Claude Sonnet 4.5',
        inputUsdPerToken: 3.0 / 1_000_000,
        outputUsdPerToken: 15.0 / 1_000_000,
        lifecycleState: 'active',
        deprecatedAt: null,
        retiresAt: null,
        replacementModel: null,
      },
      {
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        displayLabel: 'Claude Sonnet 4',
        inputUsdPerToken: 3.0 / 1_000_000,
        outputUsdPerToken: 15.0 / 1_000_000,
        lifecycleState: 'deprecated',
        deprecatedAt: new Date('2026-04-14'),
        retiresAt: new Date('2026-06-15'),
        replacementModel: 'claude-sonnet-4-5-20250929',
      },
    ];
  },
};

const EMPTY_SOURCE: CatalogSource = {
  provider: 'openai',
  async fetchCatalog(): Promise<ParsedCatalogEntry[]> {
    return [];
  },
};

describe('refreshProviderCatalog', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('upserts rows for a populated source', async () => {
    const results = await refreshProviderCatalog(asPgStore(store), [ANTHROPIC_SOURCE]);
    expect(results).toEqual([
      expect.objectContaining({ provider: 'claude', fetched: 2, upserted: 2 }),
    ]);

    const rows = await store.listProviderCatalog('claude');
    expect(rows.map((r) => r.model).sort()).toEqual([
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-5-20250929',
    ]);
  });

  it('does not wipe existing rows when the parser returns []', async () => {
    // Seed a row we would not want clobbered.
    await store.upsertProviderCatalogEntry({
      provider: 'openai',
      model: 'gpt-4o',
      displayLabel: 'GPT-4o',
      inputUsdPerToken: 2.5 / 1_000_000,
      outputUsdPerToken: 10.0 / 1_000_000,
      lifecycleState: 'active',
      deprecatedAt: null,
      retiresAt: null,
      replacementModel: null,
    });

    const results = await refreshProviderCatalog(asPgStore(store), [EMPTY_SOURCE]);
    expect(results).toEqual([
      expect.objectContaining({
        provider: 'openai',
        fetched: 0,
        upserted: 0,
        skipped: 'empty_parse',
      }),
    ]);

    // Row is still there.
    const existing = await store.getProviderCatalogEntry('openai', 'gpt-4o');
    expect(existing).not.toBeNull();
    expect(existing?.displayLabel).toBe('GPT-4o');
  });

  it('records a skipped result when a source throws, without aborting the overall run', async () => {
    const throwingSource: CatalogSource = {
      provider: 'claude',
      async fetchCatalog(): Promise<ParsedCatalogEntry[]> {
        throw new Error('upstream boom');
      },
    };
    const results = await refreshProviderCatalog(asPgStore(store), [
      throwingSource,
      ANTHROPIC_SOURCE,
    ]);
    // The throwing source is reported as skipped; the second source still wrote rows.
    // Since both sources advertise provider=claude, the second source succeeded.
    expect(results[0].skipped).toMatch(/^error:/);
    expect(results[1].upserted).toBe(2);
  });
});

describe('listAvailableModels', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('returns fallback rows when the DB is empty', async () => {
    const models = await listAvailableModels(asPgStore(store));
    // Fallback includes active claude + openai entries.
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.provider === 'claude' && m.lifecycleState === 'active')).toBe(true);
    expect(models.some((m) => m.provider === 'openai' && m.lifecycleState === 'active')).toBe(true);
  });

  it('prefers live rows over the fallback, and keeps fallback rows for missing models', async () => {
    await store.upsertProviderCatalogEntry({
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      displayLabel: 'Claude Sonnet 4.5 (live)',
      inputUsdPerToken: 3.0 / 1_000_000,
      outputUsdPerToken: 15.0 / 1_000_000,
      lifecycleState: 'active',
      deprecatedAt: null,
      retiresAt: null,
      replacementModel: null,
    });

    const models = await listAvailableModels(asPgStore(store), 'claude');
    const sonnet45 = models.find((m) => m.model === 'claude-sonnet-4-5-20250929');
    expect(sonnet45?.displayLabel).toBe('Claude Sonnet 4.5 (live)');
    // Other claude entries still come from the fallback.
    expect(models.find((m) => m.model === 'claude-opus-4-5-20251014')).toBeDefined();
  });

  it('orders active models before legacy/deprecated/retired', async () => {
    await store.upsertProviderCatalogEntry({
      provider: 'claude',
      model: 'claude-zzz-old',
      displayLabel: 'Claude Z Old',
      inputUsdPerToken: null,
      outputUsdPerToken: null,
      lifecycleState: 'deprecated',
      deprecatedAt: new Date('2026-01-01'),
      retiresAt: null,
      replacementModel: null,
    });
    await store.upsertProviderCatalogEntry({
      provider: 'claude',
      model: 'claude-aaa-new',
      displayLabel: 'Claude A New',
      inputUsdPerToken: null,
      outputUsdPerToken: null,
      lifecycleState: 'active',
      deprecatedAt: null,
      retiresAt: null,
      replacementModel: null,
    });

    const models = await listAvailableModels(asPgStore(store), 'claude');
    const activeIndexes = models
      .map((m, i) => ({ state: m.lifecycleState, i }))
      .filter((x) => x.state === 'active')
      .map((x) => x.i);
    const deprecatedIndexes = models
      .map((m, i) => ({ state: m.lifecycleState, i }))
      .filter((x) => x.state === 'deprecated')
      .map((x) => x.i);
    if (activeIndexes.length && deprecatedIndexes.length) {
      expect(Math.max(...activeIndexes)).toBeLessThan(Math.min(...deprecatedIndexes));
    }
  });
});

describe('getProviderRate', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('returns the catalog row rate when the DB has one', async () => {
    await store.upsertProviderCatalogEntry({
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      displayLabel: 'Claude Sonnet 4.5',
      inputUsdPerToken: 1.23e-6,
      outputUsdPerToken: 4.56e-6,
      lifecycleState: 'active',
      deprecatedAt: null,
      retiresAt: null,
      replacementModel: null,
    });

    const rate = await getProviderRate(asPgStore(store), 'claude', 'claude-sonnet-4-5-20250929');
    expect(rate).toEqual({ input: 1.23e-6, output: 4.56e-6 });
  });

  it('falls back to the hardcoded seed when the DB has no row', async () => {
    const rate = await getProviderRate(asPgStore(store), 'claude', 'claude-haiku-4-5');
    expect(rate).not.toBeNull();
    expect(rate?.input).toBeGreaterThan(0);
    expect(rate?.output).toBeGreaterThan(0);
  });

  it('returns null when neither source knows about the model', async () => {
    const rate = await getProviderRate(asPgStore(store), 'claude', 'claude-never-existed');
    expect(rate).toBeNull();
  });
});

describe('buildRatesOverride + calculateSavings', () => {
  it('uses a per-model rate when one is available', () => {
    const override = buildRatesOverride([
      {
        provider: 'claude',
        model: 'claude-haiku-4-5',
        displayLabel: 'Claude Haiku 4.5',
        lifecycleState: 'active',
        deprecatedAt: null,
        retiresAt: null,
        replacementModel: null,
        inputUsdPerToken: 1.0 / 1_000_000,
        outputUsdPerToken: 5.0 / 1_000_000,
      },
    ]);

    // Haiku pricing is much cheaper than the provider-level default for
    // claude, so the savings number should reflect the per-model rate.
    const withOverride = calculateSavings('claude', 1000, 500, {
      model: 'claude-haiku-4-5',
      rates: override,
    });
    const withoutOverride = calculateSavings('claude', 1000, 500);

    expect(withOverride).toBeGreaterThan(0);
    expect(withOverride).toBeLessThan(withoutOverride);
  });

  it('falls back to the provider default when the override has no entry', () => {
    const override = buildRatesOverride([]);
    const result = calculateSavings('claude', 1000, 500, {
      model: 'claude-something-unknown',
      rates: override,
    });
    const defaultResult = calculateSavings('claude', 1000, 500);
    expect(result).toEqual(defaultResult);
  });
});
