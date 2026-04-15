<!--
  Usage dashboard: shows usage statistics for the authenticated user.

  Displays request counts, token usage, cost breakdown by provider/model,
  savings from batch processing, and spend limit utilization.
-->
<script>
  import StatsCard from '$lib/components/StatsCard.svelte';
  import UsageChart from '$lib/components/UsageChart.svelte';
  import LimitBar from '$lib/components/LimitBar.svelte';

  let { data } = $props();

  const periods = [
    { value: '24h', label: 'Last 24 hours' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
  ];

  let stats = $derived(data.stats);
  let limits = $derived(data.limits);

  /**
   * Format USD amounts.
   * @param {number} value
   * @returns {string}
   */
  function fmtUsd(value) {
    if (value < 0.01 && value > 0) return '< $0.01';
    return `$${value.toFixed(2)}`;
  }

  /**
   * Format token counts with commas.
   * @param {number} value
   * @returns {string}
   */
  function fmtTokens(value) {
    return value.toLocaleString();
  }

  /**
   * Format milliseconds to a human-readable duration.
   * @param {number | null} ms
   * @returns {string}
   */
  function fmtDuration(ms) {
    if (ms == null) return 'N/A';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  /** Success rate as a percentage string. */
  let successRate = $derived(
    stats.totalRequests > 0
      ? `${((stats.succeededRequests / stats.totalRequests) * 100).toFixed(1)}%`
      : 'N/A',
  );

  /** Cost breakdown chart bars. */
  let costBars = $derived(
    stats.costBreakdown.map((entry) => ({
      label: `${entry.provider}/${entry.model}`,
      value: entry.batchCostUsd,
      color: entry.provider === 'openai' ? '#10b981' : '#2563eb',
    })),
  );

  /** Token breakdown chart bars. */
  let tokenBars = $derived(
    stats.costBreakdown.map((entry) => ({
      label: `${entry.provider}/${entry.model}`,
      value: entry.inputTokens + entry.outputTokens,
      color: entry.provider === 'openai' ? '#10b981' : '#2563eb',
    })),
  );

  /** Spend limit utilization percentage. */
  let spendUtilization = $derived(
    limits?.hardSpendLimitUsd != null && limits.hardSpendLimitUsd > 0
      ? Math.min((limits.currentSpendUsd / limits.hardSpendLimitUsd) * 100, 100)
      : null,
  );

  /** Request limit utilization percentage. */
  let requestUtilization = $derived(
    limits?.maxRequestsPerHour != null && limits.maxRequestsPerHour > 0
      ? Math.min((limits.currentPeriodRequests / limits.maxRequestsPerHour) * 100, 100)
      : null,
  );

  /** Token limit utilization percentage. */
  let tokenUtilization = $derived(
    limits?.maxTokensPerPeriod != null && limits.maxTokensPerPeriod > 0
      ? Math.min((limits.currentPeriodTokens / limits.maxTokensPerPeriod) * 100, 100)
      : null,
  );
</script>

<svelte:head>
  <title>Dashboard - norush chat</title>
</svelte:head>

<section class="dashboard">
  <div class="header">
    <h1>Usage Dashboard</h1>
    <nav class="period-selector" aria-label="Time period">
      {#each periods as p}
        <a
          href="?period={p.value}"
          class="period-btn"
          class:active={data.period === p.value}
          data-sveltekit-replacestate
        >
          {p.label}
        </a>
      {/each}
    </nav>
  </div>

  {#if data.loadError}
    <div class="alert alert-error">{data.loadError}</div>
  {/if}

  <!-- Summary cards -->
  <div class="stats-grid">
    <StatsCard
      label="Total Requests"
      value={fmtTokens(stats.totalRequests)}
      detail="{stats.totalBatches} batch{stats.totalBatches === 1 ? '' : 'es'}"
    />
    <StatsCard
      label="Success Rate"
      value={successRate}
      detail="{stats.succeededRequests} succeeded, {stats.failedRequests} failed"
    />
    <StatsCard
      label="Tokens Used"
      value={fmtTokens(stats.totalInputTokens + stats.totalOutputTokens)}
      detail="{fmtTokens(stats.totalInputTokens)} in / {fmtTokens(stats.totalOutputTokens)} out"
    />
    <StatsCard
      label="Batch Cost"
      value={fmtUsd(stats.totalBatchCostUsd)}
      detail="vs {fmtUsd(stats.totalStandardCostUsd)} real-time"
    />
    <StatsCard
      label="Savings"
      value={fmtUsd(stats.totalSavingsUsd)}
      detail={stats.totalStandardCostUsd > 0 ? '50% batch discount' : 'No usage yet'}
    />
    <StatsCard
      label="Avg Turnaround"
      value={fmtDuration(stats.avgTurnaroundMs)}
      detail="submission to completion"
    />
  </div>

  <!-- Charts -->
  <div class="charts-grid">
    <UsageChart title="Cost by Provider / Model" bars={costBars} formatValue={fmtUsd} />
    <UsageChart title="Tokens by Provider / Model" bars={tokenBars} formatValue={fmtTokens} />
  </div>

  <!-- Spend Limits -->
  {#if limits}
    <div class="limits-section">
      <h2>Spend Limits</h2>
      <div class="limits-grid">
        {#if limits.hardSpendLimitUsd != null && spendUtilization != null}
          <LimitBar
            label="Spend"
            utilization={spendUtilization}
            current={fmtUsd(limits.currentSpendUsd)}
            max={fmtUsd(limits.hardSpendLimitUsd)}
            showPct
          />
        {/if}
        {#if limits.maxRequestsPerHour != null && requestUtilization != null}
          <LimitBar
            label="Requests / hour"
            utilization={requestUtilization}
            current={fmtTokens(limits.currentPeriodRequests)}
            max={fmtTokens(limits.maxRequestsPerHour)}
          />
        {/if}
        {#if limits.maxTokensPerPeriod != null && tokenUtilization != null}
          <LimitBar
            label="Tokens / day"
            utilization={tokenUtilization}
            current={fmtTokens(limits.currentPeriodTokens)}
            max={fmtTokens(limits.maxTokensPerPeriod)}
          />
        {/if}
      </div>
    </div>
  {/if}

  <!-- Empty state -->
  {#if stats.totalRequests === 0 && !data.loadError}
    <div class="empty-state">
      <p>No activity in this period. Submit some requests to see your usage stats here.</p>
    </div>
  {/if}
</section>

<style>
  .dashboard {
    max-width: 64rem;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
  }

  h2 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }

  .period-selector {
    display: flex;
    gap: 0.25rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    padding: 0.25rem;
  }

  .period-btn {
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    text-decoration: none;
    white-space: nowrap;
    transition:
      background 0.15s,
      color 0.15s;
  }

  .period-btn:hover {
    background: #f3f4f6;
    color: var(--color-text);
    text-decoration: none;
  }

  .period-btn.active {
    background: var(--color-primary);
    color: #fff;
  }

  .period-btn.active:hover {
    background: var(--color-primary-hover);
  }

  .alert {
    padding: 0.75rem 1rem;
    border-radius: 0.375rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .alert-error {
    background: #fef2f2;
    color: #991b1b;
    border: 1px solid #fecaca;
  }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  /* Charts grid */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }

  /* Spend limits */
  .limits-section {
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
    margin-bottom: 1.5rem;
  }

  .limits-grid {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 32rem;
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-muted);
    font-style: italic;
  }
</style>
