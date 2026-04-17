<!--
  UsageChart: a lightweight CSS-based horizontal bar chart.

  Props:
    title — Heading above the chart.
    bars  — Array of { label, value, color? } objects.
    formatValue — Optional function to format the numeric value for display.
-->
<script>
  /**
   * @typedef {{ label: string; value: number; color?: string }} Bar
   */

  /**
   * @type {{
   *   title: string;
   *   bars: Bar[];
   *   formatValue?: (value: number) => string;
   * }}
   */
  let { title, bars, formatValue } = $props();

  let maxValue = $derived(Math.max(...bars.map((b) => b.value), 1));

  /**
   * @param {number} value
   * @returns {string}
   */
  function defaultFormat(value) {
    return value.toLocaleString();
  }

  let fmt = $derived(formatValue ?? defaultFormat);
</script>

<div class="chart">
  <h3 class="chart-title">{title}</h3>
  {#if bars.length === 0}
    <p class="empty">No data for this period.</p>
  {:else}
    <div class="bars">
      {#each bars as bar}
        <div class="bar-row">
          <span class="bar-label" title={bar.label}>{bar.label}</span>
          <div class="bar-track">
            <div
              class="bar-fill"
              style:width="{Math.max((bar.value / maxValue) * 100, 1)}%"
              style:background-color={bar.color ?? "var(--color-primary)"}
            ></div>
          </div>
          <span class="bar-value">{fmt(bar.value)}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chart {
    padding: 1rem 1.25rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
  }

  .chart-title {
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
  }

  .empty {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .bar-row {
    display: grid;
    grid-template-columns: 10rem 1fr 5rem;
    align-items: center;
    gap: 0.5rem;
  }

  .bar-label {
    font-size: 0.8125rem;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-track {
    height: 1.25rem;
    background: var(--color-surface-muted);
    border-radius: 0.25rem;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 0.25rem;
    transition: width 0.3s ease;
    min-width: 2px;
  }

  .bar-value {
    font-size: 0.8125rem;
    font-weight: 500;
    text-align: right;
    color: var(--color-text);
  }

  @media (max-width: 640px) {
    .bar-row {
      grid-template-columns: 6rem 1fr 4rem;
    }
  }
</style>
