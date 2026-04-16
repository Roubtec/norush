<!--
  LimitBar: utilization bar showing current vs max for a limit metric.
  Turns amber at >= 75% and red at >= 90%.
-->
<script>
  /** @type {{ label: string, utilization: number, current: string, max: string, showPct?: boolean }} */
  let { label, utilization, current, max, showPct = false } = $props();
</script>

<div class="limit-item">
  <div class="limit-header">
    <span class="limit-label">{label}</span>
    <span class="limit-values">{current} / {max}</span>
  </div>
  <div class="utilization-bar">
    <div
      class="utilization-fill"
      class:warning={utilization >= 75}
      class:danger={utilization >= 90}
      style:width="{utilization}%"
    ></div>
  </div>
  {#if showPct}
    <span class="utilization-pct">{utilization.toFixed(1)}% used</span>
  {/if}
</div>

<style>
  .limit-item {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .limit-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .limit-label {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .limit-values {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .utilization-bar {
    height: 0.5rem;
    background: var(--color-surface-muted);
    border-radius: 9999px;
    overflow: hidden;
  }

  .utilization-fill {
    height: 100%;
    background: var(--color-primary);
    border-radius: 9999px;
    transition: width 0.3s ease;
  }

  .utilization-fill.warning {
    background: var(--color-warning);
  }

  .utilization-fill.danger {
    background: var(--color-danger);
  }

  .utilization-pct {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
</style>
