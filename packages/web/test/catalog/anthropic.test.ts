/**
 * Anthropic parser tests — exercise the fixture-backed code path and the
 * "upstream returned garbage, keep existing rows" path described in the
 * task acceptance criteria.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAnthropicDeprecationPage } from '$lib/server/catalog/anthropic.js';

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'provider-catalog',
);

describe('parseAnthropicDeprecationPage', () => {
  it('extracts active, legacy, deprecated, and retired rows with lifecycle data', async () => {
    const html = await readFile(resolve(FIXTURE_DIR, 'anthropic-deprecations.html'), 'utf-8');
    const entries = parseAnthropicDeprecationPage(html);

    // We expect at least the 7 rows in the fixture.
    const byModel = new Map(entries.map((e) => [e.model, e]));

    const sonnet45 = byModel.get('claude-sonnet-4-5-20250929');
    expect(sonnet45).toBeDefined();
    expect(sonnet45?.lifecycleState).toBe('active');
    expect(sonnet45?.deprecatedAt).toBeNull();
    expect(sonnet45?.retiresAt).toBeNull();
    expect(sonnet45?.inputUsdPerToken).toBeCloseTo(3.0 / 1_000_000, 12);

    const opus4 = byModel.get('claude-opus-4-20250514');
    expect(opus4?.lifecycleState).toBe('legacy');

    const sonnet4 = byModel.get('claude-sonnet-4-20250514');
    expect(sonnet4?.lifecycleState).toBe('deprecated');
    expect(sonnet4?.deprecatedAt).toEqual(new Date('2026-04-14'));
    expect(sonnet4?.retiresAt).toEqual(new Date('2026-06-15'));
    expect(sonnet4?.replacementModel).toBe('claude-sonnet-4-5-20250929');

    const retiredHaiku = byModel.get('claude-3-5-haiku-20241022');
    expect(retiredHaiku?.lifecycleState).toBe('retired');
    expect(retiredHaiku?.deprecatedAt).toEqual(new Date('2025-12-19'));
    expect(retiredHaiku?.retiresAt).toEqual(new Date('2026-02-19'));
    expect(retiredHaiku?.replacementModel).toBe('claude-haiku-4-5');
  });

  it('returns an empty array when the status table is missing (shape change)', async () => {
    const html = await readFile(resolve(FIXTURE_DIR, 'anthropic-empty-shell.html'), 'utf-8');
    const entries = parseAnthropicDeprecationPage(html);
    expect(entries).toEqual([]);
  });

  it('backfills a display label from the model id when the page omits one', async () => {
    const html = await readFile(resolve(FIXTURE_DIR, 'anthropic-deprecations.html'), 'utf-8');
    const entries = parseAnthropicDeprecationPage(html);
    const sonnet45 = entries.find((e) => e.model === 'claude-sonnet-4-5-20250929');
    expect(sonnet45?.displayLabel).toBe('Claude Sonnet 4.5');
  });
});
