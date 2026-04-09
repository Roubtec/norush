<!--
  CostIndicator: displays estimated savings from batch processing.

  Calculates savings based on the 50% discount batch APIs provide
  over standard real-time API rates.
-->
<script>
  /**
   * @type {{ provider: string; inputTokens: number; outputTokens: number }}
   */
  let { provider, inputTokens, outputTokens } = $props();

  /**
   * Standard real-time API rates per token.
   * @type {Record<string, { input: number; output: number }>}
   */
  const STANDARD_RATES = {
    claude: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
    openai: { input: 2.5 / 1_000_000, output: 10.0 / 1_000_000 },
  };

  let savings = $derived((() => {
    const rates = STANDARD_RATES[provider] ?? STANDARD_RATES.claude;
    const standardCost =
      inputTokens * rates.input + outputTokens * rates.output;
    return standardCost * 0.5;
  })());

  let formattedSavings = $derived(
    savings < 0.01 && savings > 0
      ? "< $0.01"
      : `$${savings.toFixed(2)}`,
  );

  let totalTokens = $derived(inputTokens + outputTokens);
</script>

{#if totalTokens > 0}
  <span class="cost-indicator" title="Estimated savings vs real-time API pricing">
    You saved ~{formattedSavings}
  </span>
{/if}

<style>
  .cost-indicator {
    display: inline-block;
    font-size: 0.75rem;
    color: #166534;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    white-space: nowrap;
  }
</style>
