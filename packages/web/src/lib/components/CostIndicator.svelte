<!--
  CostIndicator: displays estimated savings from batch processing.

  Calculates savings based on the 50% discount batch APIs provide
  over standard real-time API rates.
-->
<script>
  import { calculateSavings } from "$lib/savings.js";

  /**
   * @type {{ provider: string; inputTokens: number; outputTokens: number }}
   */
  let { provider, inputTokens, outputTokens } = $props();

  let savings = $derived(calculateSavings(provider, inputTokens, outputTokens));

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
