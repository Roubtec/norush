<!--
  StatsCard: a reusable card that displays a single metric.

  Props:
    label  — Short label for the metric (e.g., "Total Requests").
    value  — The formatted value to display.
    detail — Optional secondary line of text below the value.
-->
<script>
  /**
   * @type {{ label: string; value: string; detail?: string }}
   */
  let { label, value, detail } = $props();
</script>

<div class="stats-card">
  <span class="label">{label}</span>
  <span class="value">{value}</span>
  {#if detail}
    <span class="detail">{detail}</span>
  {/if}
</div>

<style>
  .stats-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1rem 1.25rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    min-width: 0;
  }

  .label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .value {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-text);
    line-height: 1.2;
  }

  .detail {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }
</style>
