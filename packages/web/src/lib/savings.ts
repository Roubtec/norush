/**
 * Shared savings calculation utility for the chat UI.
 *
 * Centralises provider rate tables and discount logic so the per-message
 * CostIndicator component, the total-savings counter in +page.svelte, and
 * the server-side calculateSavings helper all stay in sync.
 *
 * Rates here are approximate published list prices; for live rates see
 * the provider-api-rates task.
 */

/** Standard real-time API rates (USD per token). */
export const STANDARD_RATES: Record<string, { input: number; output: number }> =
  {
    claude: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
    openai: { input: 2.5 / 1_000_000, output: 10.0 / 1_000_000 },
  };

/** Fraction of the standard cost saved when using batch APIs (50% discount). */
export const SAVINGS_DISCOUNT = 0.5;

/**
 * Calculate estimated savings from using the batch API vs real-time.
 *
 * @returns Estimated savings in USD, or 0 if token counts are unavailable.
 */
export function calculateSavings(
  provider: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number {
  if (inputTokens == null || outputTokens == null) return 0;
  const rates = STANDARD_RATES[provider] ?? STANDARD_RATES.claude;
  const standardCost = inputTokens * rates.input + outputTokens * rates.output;
  return standardCost * SAVINGS_DISCOUNT;
}
