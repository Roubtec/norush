/**
 * Internal shape used by provider-specific parsers and the refresh loop.
 *
 * `fetchCatalog()` returns an array of these. Each one is then persisted
 * via `store.upsertProviderCatalogEntry()`.
 */

import type { ProviderLifecycleState, ProviderName } from '@norush/core';

export interface ParsedCatalogEntry {
  provider: ProviderName;
  model: string;
  displayLabel: string;
  inputUsdPerToken: number | null;
  outputUsdPerToken: number | null;
  lifecycleState: ProviderLifecycleState;
  deprecatedAt: Date | null;
  retiresAt: Date | null;
  replacementModel: string | null;
}
