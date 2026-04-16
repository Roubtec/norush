/**
 * Shared savings calculation utility for the chat UI.
 *
 * Two rate sources are supported:
 *
 *   1. Fetched catalog (server-side): the canonical provider_catalog table,
 *      populated by the scheduled refresh in $lib/server/catalog.ts. This is
 *      the preferred source — it is per-model and updated from the provider's
 *      own published pricing.
 *
 *   2. Hardcoded fallback (below): used only when no catalog row exists for
 *      the requested (provider, model) pair, or in client-side contexts
 *      where the server data hasn't been threaded through yet. The fallback
 *      is a coarse per-provider average and exists so the UI still shows
 *      *some* savings estimate on a fresh deployment before the first
 *      refresh completes.
 *
 * Callers that have access to the fetched catalog must pass a `RatesOverride`
 * to `calculateSavings()` so the per-model rate is used. Callers that do not
 * (e.g. legacy client code) transparently fall back to the table below.
 */

/** Standard real-time API rates (USD per token) — provider-level fallback. */
export const STANDARD_RATES: Record<string, { input: number; output: number }> = {
  claude: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  openai: { input: 2.5 / 1_000_000, output: 10.0 / 1_000_000 },
};

/** Fraction of the standard cost saved when using batch APIs (50% discount). */
export const SAVINGS_DISCOUNT = 0.5;

/** Per-token rate pair. */
export interface RatePair {
  /** Standard real-time rate per input token, USD. */
  input: number;
  /** Standard real-time rate per output token, USD. */
  output: number;
}

/**
 * Optional per-(provider, model) rate lookup supplied by the caller.
 *
 * When provided and the lookup returns a rate pair, that rate is used in
 * preference to the hardcoded `STANDARD_RATES` table. A return value of
 * `null`/`undefined` means the catalog has no row for that pair — the
 * caller falls back to the provider-level default.
 */
export interface RatesOverride {
  getRate(provider: string, model: string): RatePair | null | undefined;
}

/**
 * Calculate estimated savings from using the batch API vs real-time.
 *
 * Prefers the override's per-model rate when available, otherwise falls
 * back to the hardcoded per-provider default. Returns 0 if token counts
 * are unavailable.
 */
export function calculateSavings(
  provider: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  options: { model?: string; rates?: RatesOverride | null } = {},
): number {
  if (inputTokens == null || outputTokens == null) return 0;
  const rates = resolveRates(provider, options.model, options.rates ?? null);
  const standardCost = inputTokens * rates.input + outputTokens * rates.output;
  return standardCost * SAVINGS_DISCOUNT;
}

/**
 * Resolve the rate pair for a given (provider, model) combination, using
 * the override when possible and falling back to `STANDARD_RATES`.
 *
 * Exposed so server code can populate a `ratesOverride` map from the
 * `provider_catalog` table and hand it to the page load.
 */
export function resolveRates(
  provider: string,
  model: string | undefined,
  override: RatesOverride | null,
): RatePair {
  if (override && model) {
    const hit = override.getRate(provider, model);
    if (hit) return hit;
  }
  return STANDARD_RATES[provider] ?? STANDARD_RATES.claude;
}
