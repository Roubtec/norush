/**
 * Hardcoded fallback list of selectable models.
 *
 * This list is the authoritative source for the Composer when the
 * `provider_catalog` table is empty (e.g. on a fresh deployment before the
 * first scheduled refresh completes) or when the scheduled refresh fails
 * and we have no cached catalog rows. Keep it conservative — a shipping
 * build must never show a retired model here, but it is fine to be out of
 * date on the newest active model (the catalog will catch up on first
 * refresh and override these entries).
 *
 * Entries must match the shape of `provider_catalog` rows so that
 * `listAvailableModels()` can blend them in uniformly. `inputUsdPerToken`
 * / `outputUsdPerToken` are per-token rates (USD).
 *
 * The lifecycle vocabulary is modelled on Anthropic's taxonomy:
 *   - active   — fully supported and recommended
 *   - legacy   — still callable, not receiving updates
 *   - deprecated — still callable but hidden from the Composer
 *   - retired  — no longer callable
 *
 * The Composer only renders `active` and `legacy` entries, so putting a
 * deprecated/retired entry here is a no-op for the UI but keeps it in the
 * catalog view for other surfaces.
 */

import type { ProviderLifecycleState } from '@norush/core';

export interface FallbackModel {
  provider: 'claude' | 'openai';
  model: string;
  displayLabel: string;
  inputUsdPerToken: number | null;
  outputUsdPerToken: number | null;
  lifecycleState: ProviderLifecycleState;
  deprecatedAt: string | null;
  retiresAt: string | null;
  replacementModel: string | null;
}

/**
 * Current-as-of-2026-04-16 baseline. When the provider-catalog refresh
 * runs successfully, these rows are superseded by live data. Do not edit
 * this file to work around a failed scrape — fix the parser instead.
 */
export const FALLBACK_MODELS: readonly FallbackModel[] = Object.freeze([
  // -- Anthropic (Claude) -------------------------------------------------
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
    model: 'claude-opus-4-5-20251014',
    displayLabel: 'Claude Opus 4.5',
    inputUsdPerToken: 15.0 / 1_000_000,
    outputUsdPerToken: 75.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'claude',
    model: 'claude-haiku-4-5',
    displayLabel: 'Claude Haiku 4.5',
    inputUsdPerToken: 1.0 / 1_000_000,
    outputUsdPerToken: 5.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  // Kept here so the catalog still knows about the deprecated model's
  // replacement hint for existing in-flight UIs. Composer hides it.
  {
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    displayLabel: 'Claude Sonnet 4',
    inputUsdPerToken: 3.0 / 1_000_000,
    outputUsdPerToken: 15.0 / 1_000_000,
    lifecycleState: 'deprecated',
    deprecatedAt: '2026-04-14',
    retiresAt: '2026-06-15',
    replacementModel: 'claude-sonnet-4-5-20250929',
  },
  {
    provider: 'claude',
    model: 'claude-3-5-haiku-20241022',
    displayLabel: 'Claude 3.5 Haiku',
    inputUsdPerToken: 0.8 / 1_000_000,
    outputUsdPerToken: 4.0 / 1_000_000,
    lifecycleState: 'retired',
    deprecatedAt: '2025-12-19',
    retiresAt: '2026-02-19',
    replacementModel: 'claude-haiku-4-5',
  },

  // -- OpenAI (batch/flex prices per token) ----------------------------------
  // Active frontier
  {
    provider: 'openai',
    model: 'gpt-5.4',
    displayLabel: 'GPT-5.4',
    inputUsdPerToken: 1.25 / 1_000_000,
    outputUsdPerToken: 7.5 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    displayLabel: 'GPT-5.4 mini',
    inputUsdPerToken: 0.375 / 1_000_000,
    outputUsdPerToken: 2.25 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.4-nano',
    displayLabel: 'GPT-5.4 nano',
    inputUsdPerToken: 0.10 / 1_000_000,
    outputUsdPerToken: 0.625 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.2',
    displayLabel: 'GPT-5.2',
    inputUsdPerToken: 0.875 / 1_000_000,
    outputUsdPerToken: 7.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5.1',
    displayLabel: 'GPT-5.1',
    inputUsdPerToken: 0.625 / 1_000_000,
    outputUsdPerToken: 5.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5',
    displayLabel: 'GPT-5',
    inputUsdPerToken: 0.625 / 1_000_000,
    outputUsdPerToken: 5.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    displayLabel: 'GPT-5 mini',
    inputUsdPerToken: 0.125 / 1_000_000,
    outputUsdPerToken: 1.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-5-nano',
    displayLabel: 'GPT-5 nano',
    inputUsdPerToken: 0.025 / 1_000_000,
    outputUsdPerToken: 0.20 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1',
    displayLabel: 'GPT-4.1',
    inputUsdPerToken: 1.0 / 1_000_000,
    outputUsdPerToken: 4.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    displayLabel: 'GPT-4.1 mini',
    inputUsdPerToken: 0.20 / 1_000_000,
    outputUsdPerToken: 0.80 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'o3',
    displayLabel: 'o3',
    inputUsdPerToken: 1.0 / 1_000_000,
    outputUsdPerToken: 4.0 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  {
    provider: 'openai',
    model: 'o4-mini',
    displayLabel: 'o4-mini',
    inputUsdPerToken: 0.55 / 1_000_000,
    outputUsdPerToken: 2.2 / 1_000_000,
    lifecycleState: 'active',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: null,
  },
  // Legacy — gpt-4o generation superseded by gpt-5 family
  {
    provider: 'openai',
    model: 'gpt-4o',
    displayLabel: 'GPT-4o',
    inputUsdPerToken: 1.25 / 1_000_000,
    outputUsdPerToken: 5.0 / 1_000_000,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-5',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    displayLabel: 'GPT-4o mini',
    inputUsdPerToken: 0.075 / 1_000_000,
    outputUsdPerToken: 0.30 / 1_000_000,
    lifecycleState: 'legacy',
    deprecatedAt: null,
    retiresAt: null,
    replacementModel: 'gpt-5-mini',
  },
]);
