<!--
  CostIndicator: displays estimated savings from batch processing.

  Uses the server-fetched per-model rate when a `rates` override is
  provided, otherwise falls back to the hardcoded per-provider table in
  $lib/savings.
-->
<script>
  import { calculateSavings } from "$lib/savings.js";

  /**
   * @type {{
   *   provider: string;
   *   model?: string;
   *   inputTokens: number;
   *   outputTokens: number;
   *   rates?: { getRate(provider: string, model: string): { input: number; output: number } | null | undefined } | null;
   * }}
   */
  let { provider, model, inputTokens, outputTokens, rates = null } = $props();

  let savings = $derived(
    calculateSavings(provider, inputTokens, outputTokens, { model, rates }),
  );

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
