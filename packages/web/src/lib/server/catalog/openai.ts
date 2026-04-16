/**
 * OpenAI provider catalog source.
 *
 * OpenAI's deprecation page (`https://platform.openai.com/docs/deprecations`)
 * is JS-rendered: a plain server-side `fetch()` returns an empty Next.js
 * shell with no useful data. The page does, however, embed its data in a
 * `__NEXT_DATA__` script tag, so if we ever do see a populated shell we
 * can recover entries from there. The parser here handles both shapes.
 *
 * Until a stable source ships, we also carry a manually-curated seed list
 * inside the module. The scheduled refresh prefers whatever the parser
 * returns and falls back to the seed on parse failure — this is called
 * out explicitly in the final task report, per the "do not pretend to
 * scrape if you actually hardcode" instruction.
 *
 * OpenAI's "shutdown" state maps to our `retired` vocabulary.
 */

import type { ProviderLifecycleState } from '@norush/core';
import type { ParsedCatalogEntry } from './types.js';

// ---------------------------------------------------------------------------
// Known URLs (exported for tests + ops docs)
// ---------------------------------------------------------------------------

export const OPENAI_DEPRECATIONS_URL = 'https://platform.openai.com/docs/deprecations';

// ---------------------------------------------------------------------------
// Pricing map (USD per token). Update manually when OpenAI announces a
// price change — see the note at the top of the file for why we keep this
// hardcoded rather than live-fetched.
// ---------------------------------------------------------------------------

const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5 / 1_000_000, output: 10.0 / 1_000_000 },
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  'gpt-4-turbo': { input: 10.0 / 1_000_000, output: 30.0 / 1_000_000 },
  'gpt-4': { input: 30.0 / 1_000_000, output: 60.0 / 1_000_000 },
  'gpt-3.5-turbo': { input: 0.5 / 1_000_000, output: 1.5 / 1_000_000 },
  'gpt-3.5-turbo-0613': { input: 0.5 / 1_000_000, output: 1.5 / 1_000_000 },
};

// ---------------------------------------------------------------------------
// Seed list — what we report when live fetch/parse yields nothing. Keep
// this file's state column aligned with the published OpenAI deprecation
// page; the Composer relies on `retired`/`deprecated` being accurate.
// ---------------------------------------------------------------------------

const SEED: ParsedCatalogEntry[] = [
  {
    provider: 'openai',
    model: 'gpt-4o',
    displayLabel: 'GPT-4o',
    inputUsdPerToken: OPENAI_PRICING['gpt-4o'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4o'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    displayLabel: 'GPT-4o mini',
    inputUsdPerToken: OPENAI_PRICING['gpt-4o-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4o-mini'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-4-turbo',
    displayLabel: 'GPT-4 Turbo',
    inputUsdPerToken: OPENAI_PRICING['gpt-4-turbo'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4-turbo'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-4o',
  },
  {
    provider: 'openai',
    model: 'gpt-3.5-turbo-0613',
    displayLabel: 'GPT-3.5 Turbo (0613)',
    inputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-0613'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-0613'].output,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2023-09-13'),
    retiresAt: new Date('2024-06-13'),
    replacementModel: 'gpt-3.5-turbo',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseState(raw: string | undefined | null): ProviderLifecycleState {
  const s = (raw ?? '').toLowerCase().trim();
  if (s === 'active') return 'active';
  if (s === 'legacy') return 'legacy';
  if (s === 'deprecated') return 'deprecated';
  // OpenAI calls this "shutdown"; we normalise to "retired".
  if (s === 'shutdown' || s === 'retired' || s === 'sunset') return 'retired';
  return 'active';
}

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

function titleCaseFromModelId(model: string): string {
  return model
    .split('-')
    .map((p) => (p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(' ')
    .replace(/\bGpt\b/g, 'GPT');
}

function extractNextDataPayload(html: string): unknown | null {
  // Next.js pages embed their server-rendered data in this script tag.
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

interface RawOpenAIModel {
  model?: string;
  name?: string;
  status?: string;
  state?: string;
  deprecated_at?: string;
  deprecation_date?: string;
  shutdown_at?: string;
  shutdown_date?: string;
  retirement_date?: string;
  replacement?: string;
  replacement_model?: string;
  recommended_replacement?: string;
  input_price_per_token?: number;
  output_price_per_token?: number;
}

function collectModelRecords(payload: unknown): RawOpenAIModel[] {
  // Walk the payload tree and yield any object that looks like a model
  // entry. We don't hard-code the Next.js page shape because it has
  // churned historically.
  const out: RawOpenAIModel[] = [];

  function visit(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const candidate = obj as RawOpenAIModel;
    // A "model record" has a model id and at least a status field.
    if (
      typeof candidate.model === 'string' &&
      (typeof candidate.status === 'string' || typeof candidate.state === 'string')
    ) {
      out.push(candidate);
    }
    for (const value of Object.values(obj)) visit(value);
  }

  visit(payload);
  return out;
}

function rawToEntry(raw: RawOpenAIModel): ParsedCatalogEntry | null {
  const model = raw.model;
  if (!model || typeof model !== 'string') return null;

  const pricing = OPENAI_PRICING[model] ?? null;

  return {
    provider: 'openai',
    model,
    displayLabel:
      typeof raw.name === 'string' && raw.name.trim() ? raw.name : titleCaseFromModelId(model),
    inputUsdPerToken:
      typeof raw.input_price_per_token === 'number'
        ? raw.input_price_per_token
        : (pricing?.input ?? null),
    outputUsdPerToken:
      typeof raw.output_price_per_token === 'number'
        ? raw.output_price_per_token
        : (pricing?.output ?? null),
    lifecycleState: normaliseState(raw.status ?? raw.state),
    deprecatedAt: parseDate(raw.deprecated_at ?? raw.deprecation_date),
    retiresAt: parseDate(raw.shutdown_at ?? raw.shutdown_date ?? raw.retirement_date),
    replacementModel:
      raw.replacement_model ?? raw.replacement ?? raw.recommended_replacement ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure parser: HTML → catalog entries. Returns [] on shape mismatch so
 * callers preserve existing rows.
 *
 * In practice, OpenAI's live page currently returns an unpopulated Next.js
 * shell to server-side `fetch()`, so this usually returns []. We still ship
 * the parser so the moment OpenAI either ships a stable source or includes
 * their data in `__NEXT_DATA__`, the refresh picks it up with no code
 * change required.
 */
export function parseOpenAIDeprecationPage(html: string): ParsedCatalogEntry[] {
  const payload = extractNextDataPayload(html);
  if (!payload) return [];
  const records = collectModelRecords(payload);
  if (records.length === 0) return [];

  const byModel = new Map<string, ParsedCatalogEntry>();
  for (const raw of records) {
    const entry = rawToEntry(raw);
    if (entry) byModel.set(entry.model, entry);
  }
  return [...byModel.values()];
}

/**
 * Live-fetch + fallback to the manually-curated seed.
 *
 * This is the OpenAI entry point for the scheduled refresh. It tries the
 * live page first; on empty (shape change / JS-only render) it falls
 * through to the seed. This keeps the Composer usable even when OpenAI's
 * docs page is unreachable or has churned.
 */
export async function fetchOpenAICatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedCatalogEntry[]> {
  try {
    const res = await fetchImpl(OPENAI_DEPRECATIONS_URL, { headers: { accept: 'text/html' } });
    if (res.ok) {
      const html = await res.text();
      const parsed = parseOpenAIDeprecationPage(html);
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // fall through to seed
  }
  return SEED.map((e) => ({ ...e }));
}

/** Exported for tests. */
export { SEED as OPENAI_SEED };
