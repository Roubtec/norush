/**
 * Token pricing rates for cost estimation.
 *
 * Standard real-time API rates per token. Batch APIs typically offer 50%
 * discount over these rates. Rates are approximate averages — actual rates
 * vary by model. Uses default model pricing as a baseline; can be refined
 * per-model over time.
 */

/** Per-token rate in USD. */
export interface TokenRates {
  input: number;
  output: number;
}

/**
 * Standard (real-time) rates per million tokens, keyed by provider.
 * Where a model-specific rate is not available, the provider default is used.
 */
export const STANDARD_RATES: Record<string, TokenRates> = {
  claude: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  openai: { input: 2.5 / 1_000_000, output: 10.0 / 1_000_000 },
};

/** Batch discount factor (e.g., 0.5 means batch costs 50% of standard). */
export const BATCH_DISCOUNT = 0.5;

/** Look up the standard token rates for a provider (falls back to claude). */
export function getRates(provider: string): TokenRates {
  return STANDARD_RATES[provider] ?? STANDARD_RATES.claude;
}

/** Calculate the standard (real-time) cost for a set of tokens. */
export function standardCost(provider: string, inputTokens: number, outputTokens: number): number {
  const rates = getRates(provider);
  return inputTokens * rates.input + outputTokens * rates.output;
}

/** Calculate the batch (discounted) cost for a set of tokens. */
export function batchCost(provider: string, inputTokens: number, outputTokens: number): number {
  return standardCost(provider, inputTokens, outputTokens) * BATCH_DISCOUNT;
}

/** Calculate savings (standard - batch). */
export function savings(provider: string, inputTokens: number, outputTokens: number): number {
  const std = standardCost(provider, inputTokens, outputTokens);
  return std - std * BATCH_DISCOUNT;
}
