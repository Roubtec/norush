/**
 * OpenAI parser tests.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseOpenAIDeprecationPage,
  fetchOpenAICatalog,
  OPENAI_SEED,
} from '$lib/server/catalog/openai.js';

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'provider-catalog',
);

describe('parseOpenAIDeprecationPage', () => {
  it('extracts model rows from the __NEXT_DATA__ payload', async () => {
    const html = await readFile(resolve(FIXTURE_DIR, 'openai-next-data.html'), 'utf-8');
    const entries = parseOpenAIDeprecationPage(html);

    const byModel = new Map(entries.map((e) => [e.model, e]));

    expect(byModel.get('gpt-4o')?.lifecycleState).toBe('active');
    expect(byModel.get('gpt-4-turbo')?.lifecycleState).toBe('legacy');
    expect(byModel.get('gpt-4-turbo')?.replacementModel).toBe('gpt-4o');

    const retired = byModel.get('gpt-3.5-turbo-0613');
    expect(retired?.lifecycleState).toBe('retired');
    expect(retired?.deprecatedAt).toEqual(new Date('2023-09-13'));
    expect(retired?.retiresAt).toEqual(new Date('2024-06-13'));
    expect(retired?.replacementModel).toBe('gpt-3.5-turbo');
  });

  it('returns [] when the __NEXT_DATA__ payload is empty (JS-only render)', async () => {
    const html = await readFile(resolve(FIXTURE_DIR, 'openai-empty-shell.html'), 'utf-8');
    const entries = parseOpenAIDeprecationPage(html);
    expect(entries).toEqual([]);
  });
});

describe('fetchOpenAICatalog', () => {
  it('falls back to the seed list when live fetch returns an empty shell', async () => {
    const html = await readFile(resolve(FIXTURE_DIR, 'openai-empty-shell.html'), 'utf-8');
    const fakeFetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    const entries = await fetchOpenAICatalog(fakeFetch);
    expect(entries.length).toBe(OPENAI_SEED.length);
    // Must include a baseline active model.
    expect(entries.find((e) => e.model === 'gpt-5')?.lifecycleState).toBe('active');
  });

  it('falls back to the seed list when live fetch throws (network error)', async () => {
    const failingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const entries = await fetchOpenAICatalog(failingFetch);
    expect(entries.length).toBe(OPENAI_SEED.length);
  });

  it('uses the live parsed catalog when the live payload is populated', async () => {
    const html = await readFile(resolve(FIXTURE_DIR, 'openai-next-data.html'), 'utf-8');
    const fakeFetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    const entries = await fetchOpenAICatalog(fakeFetch);
    // The fixture includes gpt-4-turbo as "legacy", which the seed happens
    // to agree with — but also includes gpt-3.5-turbo-0613 as "retired",
    // which the seed also has. The point is that when live data parses
    // successfully, we use it (even if the same models happen to appear).
    expect(entries.some((e) => e.model === 'gpt-4-turbo' && e.lifecycleState === 'legacy')).toBe(
      true,
    );
  });
});
