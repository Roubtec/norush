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

// All prices are batch/flex tier (= 50% of standard). NoRush submits via
// the Batch API so this is the cost users actually incur. Source:
// https://developers.openai.com/api/docs/pricing (batch tab), 2026-04-16.
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  // gpt-5.4 family
  'gpt-5.4': { input: 1.25 / 1_000_000, output: 7.5 / 1_000_000 },
  'gpt-5.4-mini': { input: 0.375 / 1_000_000, output: 2.25 / 1_000_000 },
  'gpt-5.4-nano': { input: 0.10 / 1_000_000, output: 0.625 / 1_000_000 },
  'gpt-5.4-pro': { input: 15.0 / 1_000_000, output: 90.0 / 1_000_000 },
  // gpt-5.2 family
  'gpt-5.2': { input: 0.875 / 1_000_000, output: 7.0 / 1_000_000 },
  'gpt-5.2-pro': { input: 10.5 / 1_000_000, output: 84.0 / 1_000_000 },
  // gpt-5.1 / gpt-5 family
  'gpt-5.1': { input: 0.625 / 1_000_000, output: 5.0 / 1_000_000 },
  'gpt-5': { input: 0.625 / 1_000_000, output: 5.0 / 1_000_000 },
  'gpt-5-mini': { input: 0.125 / 1_000_000, output: 1.0 / 1_000_000 },
  'gpt-5-nano': { input: 0.025 / 1_000_000, output: 0.20 / 1_000_000 },
  'gpt-5-pro': { input: 7.5 / 1_000_000, output: 60.0 / 1_000_000 },
  // gpt-4.1 family
  'gpt-4.1': { input: 1.0 / 1_000_000, output: 4.0 / 1_000_000 },
  'gpt-4.1-mini': { input: 0.20 / 1_000_000, output: 0.80 / 1_000_000 },
  'gpt-4.1-nano': { input: 0.05 / 1_000_000, output: 0.20 / 1_000_000 },
  // gpt-4o family (legacy)
  'gpt-4o': { input: 1.25 / 1_000_000, output: 5.0 / 1_000_000 },
  'gpt-4o-2024-05-13': { input: 2.5 / 1_000_000, output: 7.5 / 1_000_000 },
  'gpt-4o-mini': { input: 0.075 / 1_000_000, output: 0.30 / 1_000_000 },
  // Reasoning models
  'o1': { input: 7.5 / 1_000_000, output: 30.0 / 1_000_000 },
  'o1-pro': { input: 75.0 / 1_000_000, output: 300.0 / 1_000_000 },
  'o3': { input: 1.0 / 1_000_000, output: 4.0 / 1_000_000 },
  'o3-pro': { input: 10.0 / 1_000_000, output: 40.0 / 1_000_000 },
  'o4-mini': { input: 0.55 / 1_000_000, output: 2.2 / 1_000_000 },
  'o3-mini': { input: 0.55 / 1_000_000, output: 2.2 / 1_000_000 },
  // gpt-4-turbo family (legacy)
  'gpt-4-turbo': { input: 5.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'gpt-4-turbo-2024-04-09': { input: 5.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'gpt-4-0613': { input: 15.0 / 1_000_000, output: 30.0 / 1_000_000 },
  // gpt-3.5 family
  'gpt-3.5-turbo': { input: 0.25 / 1_000_000, output: 0.75 / 1_000_000 },
  'gpt-3.5-turbo-0125': { input: 0.25 / 1_000_000, output: 0.75 / 1_000_000 },
  'gpt-3.5-turbo-1106': { input: 1.0 / 1_000_000, output: 2.0 / 1_000_000 },
  // Retired — kept for savings display on historical messages
  'gpt-4-32k': { input: 30.0 / 1_000_000, output: 60.0 / 1_000_000 },
  'gpt-4-0125-preview': { input: 5.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'gpt-4-1106-preview': { input: 5.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'gpt-4-0314': { input: 15.0 / 1_000_000, output: 30.0 / 1_000_000 },
  'gpt-3.5-turbo-0613': { input: 1.5 / 1_000_000, output: 2.0 / 1_000_000 },
  'o1-mini': { input: 0.55 / 1_000_000, output: 2.2 / 1_000_000 },
};

// ---------------------------------------------------------------------------
// Seed list — what we report when live fetch/parse yields nothing. Keep
// this file's state column aligned with the published OpenAI deprecation
// page; the Composer relies on `retired`/`deprecated` being accurate.
// ---------------------------------------------------------------------------

// Seed last updated 2026-04-16.
// Sources: https://developers.openai.com/api/docs/deprecations
//          https://developers.openai.com/api/docs/models/all
//          https://developers.openai.com/api/docs/pricing (batch tab)
const SEED: ParsedCatalogEntry[] = [
  // -- Active (frontier) ----------------------------------------------------

  // gpt-5.4 family
  {
    provider: 'openai',
    model: 'gpt-5.4',
    displayLabel: 'GPT-5.4',
    inputUsdPerToken: OPENAI_PRICING['gpt-5.4'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5.4'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.4-pro',
    displayLabel: 'GPT-5.4 Pro',
    inputUsdPerToken: OPENAI_PRICING['gpt-5.4-pro'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5.4-pro'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    displayLabel: 'GPT-5.4 mini',
    inputUsdPerToken: OPENAI_PRICING['gpt-5.4-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5.4-mini'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.4-nano',
    displayLabel: 'GPT-5.4 nano',
    inputUsdPerToken: OPENAI_PRICING['gpt-5.4-nano'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5.4-nano'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },

  // gpt-5.2 family
  {
    provider: 'openai',
    model: 'gpt-5.2',
    displayLabel: 'GPT-5.2',
    inputUsdPerToken: OPENAI_PRICING['gpt-5.2'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5.2'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.2-pro',
    displayLabel: 'GPT-5.2 Pro',
    inputUsdPerToken: OPENAI_PRICING['gpt-5.2-pro'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5.2-pro'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },

  // gpt-5.1 / gpt-5 family
  {
    provider: 'openai',
    model: 'gpt-5.1',
    displayLabel: 'GPT-5.1',
    inputUsdPerToken: OPENAI_PRICING['gpt-5.1'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5.1'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5',
    displayLabel: 'GPT-5',
    inputUsdPerToken: OPENAI_PRICING['gpt-5'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    displayLabel: 'GPT-5 mini',
    inputUsdPerToken: OPENAI_PRICING['gpt-5-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5-mini'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5-nano',
    displayLabel: 'GPT-5 nano',
    inputUsdPerToken: OPENAI_PRICING['gpt-5-nano'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5-nano'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5-pro',
    displayLabel: 'GPT-5 Pro',
    inputUsdPerToken: OPENAI_PRICING['gpt-5-pro'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-5-pro'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },

  // gpt-4.1 family
  {
    provider: 'openai',
    model: 'gpt-4.1',
    displayLabel: 'GPT-4.1',
    inputUsdPerToken: OPENAI_PRICING['gpt-4.1'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4.1'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    displayLabel: 'GPT-4.1 mini',
    inputUsdPerToken: OPENAI_PRICING['gpt-4.1-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4.1-mini'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-nano',
    displayLabel: 'GPT-4.1 nano',
    inputUsdPerToken: OPENAI_PRICING['gpt-4.1-nano'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4.1-nano'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },

  // Reasoning models
  {
    provider: 'openai',
    model: 'o3',
    displayLabel: 'o3',
    inputUsdPerToken: OPENAI_PRICING['o3'].input,
    outputUsdPerToken: OPENAI_PRICING['o3'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'o3-pro',
    displayLabel: 'o3 Pro',
    inputUsdPerToken: OPENAI_PRICING['o3-pro'].input,
    outputUsdPerToken: OPENAI_PRICING['o3-pro'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'o4-mini',
    displayLabel: 'o4-mini',
    inputUsdPerToken: OPENAI_PRICING['o4-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['o4-mini'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'o1-pro',
    displayLabel: 'o1 Pro',
    inputUsdPerToken: OPENAI_PRICING['o1-pro'].input,
    outputUsdPerToken: OPENAI_PRICING['o1-pro'].output,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },

  // -- Legacy (still callable; not listed as deprecated) --------------------

  {
    provider: 'openai',
    model: 'gpt-4o',
    displayLabel: 'GPT-4o',
    inputUsdPerToken: OPENAI_PRICING['gpt-4o'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4o'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-5',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    displayLabel: 'GPT-4o mini',
    inputUsdPerToken: OPENAI_PRICING['gpt-4o-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4o-mini'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-5-mini',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-2024-05-13',
    displayLabel: 'GPT-4o (2024-05-13)',
    inputUsdPerToken: OPENAI_PRICING['gpt-4o-2024-05-13'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4o-2024-05-13'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-4o',
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
    replacementModel: 'gpt-4.1',
  },
  {
    provider: 'openai',
    model: 'gpt-4-turbo-2024-04-09',
    displayLabel: 'GPT-4 Turbo (2024-04-09)',
    inputUsdPerToken: OPENAI_PRICING['gpt-4-turbo-2024-04-09'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4-turbo-2024-04-09'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-4.1',
  },
  {
    provider: 'openai',
    model: 'gpt-4-0613',
    displayLabel: 'GPT-4 (0613)',
    inputUsdPerToken: OPENAI_PRICING['gpt-4-0613'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4-0613'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-4.1',
  },
  {
    provider: 'openai',
    model: 'o1',
    displayLabel: 'o1',
    inputUsdPerToken: OPENAI_PRICING['o1'].input,
    outputUsdPerToken: OPENAI_PRICING['o1'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'o3',
  },
  {
    provider: 'openai',
    model: 'o3-mini',
    displayLabel: 'o3-mini',
    inputUsdPerToken: OPENAI_PRICING['o3-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['o3-mini'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'o4-mini',
  },
  {
    provider: 'openai',
    model: 'gpt-3.5-turbo',
    displayLabel: 'GPT-3.5 Turbo',
    inputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-5-mini',
  },
  {
    provider: 'openai',
    model: 'gpt-3.5-turbo-0125',
    displayLabel: 'GPT-3.5 Turbo (0125)',
    inputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-0125'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-0125'].output,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-5-mini',
  },

  // -- Deprecated (shutdown date not yet reached as of 2026-04-16) ----------

  {
    provider: 'openai',
    model: 'gpt-3.5-turbo-1106',
    displayLabel: 'GPT-3.5 Turbo (1106)',
    inputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-1106'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-1106'].output,
    lifecycleState: 'deprecated',
    deprecatedAt: new Date('2025-09-26'),
    retiresAt: new Date('2026-09-28'),
    replacementModel: 'gpt-5.4-mini',
  },

  // -- Retired (shutdown date passed as of 2026-04-16) ----------------------
  // Kept so the batch-manager preflight can gate any in-flight jobs that
  // were submitted against these models before they were retired.

  {
    provider: 'openai',
    model: 'gpt-4-0125-preview',
    displayLabel: 'GPT-4 Turbo Preview (0125)',
    inputUsdPerToken: OPENAI_PRICING['gpt-4-0125-preview'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4-0125-preview'].output,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2025-09-26'),
    retiresAt: new Date('2026-03-26'),
    replacementModel: 'gpt-4.1',
  },
  {
    provider: 'openai',
    model: 'gpt-4-1106-preview',
    displayLabel: 'GPT-4 Turbo Preview (1106)',
    inputUsdPerToken: OPENAI_PRICING['gpt-4-1106-preview'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4-1106-preview'].output,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2025-09-26'),
    retiresAt: new Date('2026-03-26'),
    replacementModel: 'gpt-4.1',
  },
  {
    provider: 'openai',
    model: 'gpt-4-0314',
    displayLabel: 'GPT-4 (0314)',
    inputUsdPerToken: OPENAI_PRICING['gpt-4-0314'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4-0314'].output,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2025-09-26'),
    retiresAt: new Date('2026-03-26'),
    replacementModel: 'gpt-4.1',
  },
  {
    provider: 'openai',
    model: 'gpt-4-32k',
    displayLabel: 'GPT-4 32K',
    inputUsdPerToken: OPENAI_PRICING['gpt-4-32k'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-4-32k'].output,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2024-06-06'),
    retiresAt: new Date('2025-06-06'),
    replacementModel: 'gpt-4o',
  },
  {
    provider: 'openai',
    model: 'gpt-4.5-preview',
    displayLabel: 'GPT-4.5 Preview',
    inputUsdPerToken: null,
    outputUsdPerToken: null,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2025-04-14'),
    retiresAt: new Date('2025-07-14'),
    replacementModel: 'gpt-4.1',
  },
  {
    provider: 'openai',
    model: 'o1-preview',
    displayLabel: 'o1-preview',
    inputUsdPerToken: null,
    outputUsdPerToken: null,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2025-04-28'),
    retiresAt: new Date('2025-07-28'),
    replacementModel: 'o3',
  },
  {
    provider: 'openai',
    model: 'o1-mini',
    displayLabel: 'o1-mini',
    inputUsdPerToken: OPENAI_PRICING['o1-mini'].input,
    outputUsdPerToken: OPENAI_PRICING['o1-mini'].output,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2025-04-28'),
    retiresAt: new Date('2025-10-27'),
    replacementModel: 'o4-mini',
  },
  {
    provider: 'openai',
    model: 'chatgpt-4o-latest',
    displayLabel: 'ChatGPT-4o Latest',
    inputUsdPerToken: null,
    outputUsdPerToken: null,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2025-11-18'),
    retiresAt: new Date('2026-02-17'),
    replacementModel: 'gpt-5.1-chat-latest',
  },
  {
    provider: 'openai',
    model: 'gpt-3.5-turbo-0613',
    displayLabel: 'GPT-3.5 Turbo (0613)',
    inputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-0613'].input,
    outputUsdPerToken: OPENAI_PRICING['gpt-3.5-turbo-0613'].output,
    lifecycleState: 'retired',
    deprecatedAt: new Date('2023-09-13'),
    retiresAt: new Date('2024-09-13'),
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
/** Timeout for upstream catalog fetches (10 s). Prevents a hung connection
 *  from stalling the hourly refresh loop indefinitely. */
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchOpenAICatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedCatalogEntry[]> {
  try {
    const res = await fetchImpl(OPENAI_DEPRECATIONS_URL, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const html = await res.text();
      const parsed = parseOpenAIDeprecationPage(html);
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // fall through to seed (covers network errors, timeouts, and shape changes)
  }
  return SEED.map((e) => ({ ...e }));
}

/** Exported for tests. */
export { SEED as OPENAI_SEED };
