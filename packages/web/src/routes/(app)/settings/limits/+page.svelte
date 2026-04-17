<!--
  Spend limit configuration settings page.

  Users can set their own per-hour request limit, per-day token limit,
  and hard USD spend ceiling. Empty fields mean unlimited.
-->
<script>
  import { enhance } from "$app/forms";

  let { data, form } = $props();

  /**
   * Extract error message for a specific field.
   * @param {string} field
   */
  function fieldError(field) {
    if (!form?.errors) return null;
    const err = form.errors.find((e) => e.field === field);
    return err?.message ?? null;
  }

  /**
   * Get the current value for a form field, preferring form action
   * values (on validation failure) over loaded data.
   * @param {string|number|null|undefined} formValue
   * @param {string|number|null|undefined} loadedValue
   */
  function fieldValue(formValue, loadedValue) {
    if (formValue !== undefined && formValue !== null) {
      return formValue;
    }
    return loadedValue ?? "";
  }
</script>

<svelte:head>
  <title>Spend Limits - norush chat</title>
</svelte:head>

<section class="settings">
  <h1>Spend Limits</h1>
  <p class="subtitle">
    Configure rate limits and spend caps for your account. Leave fields empty
    for unlimited. Limits are enforced when submitting new requests.
  </p>

  <!-- Error loading limits -->
  {#if data.loadError}
    <div class="alert alert-error">{data.loadError}</div>
  {/if}

  <!-- Success message -->
  {#if form?.success}
    <div class="alert alert-success">Spend limits updated successfully.</div>
  {/if}

  <!-- General form error -->
  {#if form?.errors}
    {#each form.errors.filter((e) => e.field === "general") as err}
      <div class="alert alert-error">{err.message}</div>
    {/each}
  {/if}

  <!-- Current usage summary -->
  {#if data.limits}
    <div class="usage-section">
      <h2>Current Usage</h2>
      <div class="usage-grid">
        <div class="usage-card">
          <span class="usage-label">Requests this period</span>
          <span class="usage-value">
            {data.limits.currentPeriodRequests}
            {#if data.limits.maxRequestsPerHour !== null}
              <span class="usage-cap">/ {data.limits.maxRequestsPerHour}</span>
            {:else}
              <span class="usage-cap">/ unlimited</span>
            {/if}
          </span>
        </div>
        <div class="usage-card">
          <span class="usage-label">Tokens this period</span>
          <span class="usage-value">
            {data.limits.currentPeriodTokens.toLocaleString()}
            {#if data.limits.maxTokensPerPeriod !== null}
              <span class="usage-cap"
                >/ {data.limits.maxTokensPerPeriod.toLocaleString()}</span
              >
            {:else}
              <span class="usage-cap">/ unlimited</span>
            {/if}
          </span>
        </div>
        <div class="usage-card">
          <span class="usage-label">Total spend</span>
          <span class="usage-value">
            ${data.limits.currentSpendUsd.toFixed(2)}
            {#if data.limits.hardSpendLimitUsd !== null}
              <span class="usage-cap"
                >/ ${data.limits.hardSpendLimitUsd.toFixed(2)}</span
              >
            {:else}
              <span class="usage-cap">/ unlimited</span>
            {/if}
          </span>
        </div>
        <div class="usage-card">
          <span class="usage-label">Period resets</span>
          <span class="usage-value usage-date">
            {new Date(data.limits.periodResetAt).toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Limit configuration form -->
  <div class="config-section">
    <h2>Configure Limits</h2>

    <form method="POST" action="?/update" use:enhance class="config-form">
      <div class="field">
        <label for="maxRequestsPerHour">Max requests per hour</label>
        <input
          type="number"
          id="maxRequestsPerHour"
          name="maxRequestsPerHour"
          placeholder="Unlimited"
          min="1"
          value={fieldValue(
            form?.values?.maxRequestsPerHour,
            data.limits?.maxRequestsPerHour,
          )}
        />
        <span class="field-hint">
          Maximum number of requests you can submit per rolling hour. Adaptive
          rate limiting may reduce this further during failures.
        </span>
        {#if fieldError("maxRequestsPerHour")}
          <span class="field-error">{fieldError("maxRequestsPerHour")}</span>
        {/if}
      </div>

      <div class="field">
        <label for="maxTokensPerPeriod">Max tokens per period</label>
        <input
          type="number"
          id="maxTokensPerPeriod"
          name="maxTokensPerPeriod"
          placeholder="Unlimited"
          min="1"
          value={fieldValue(
            form?.values?.maxTokensPerPeriod,
            data.limits?.maxTokensPerPeriod,
          )}
        />
        <span class="field-hint">
          Estimated token budget per rolling period. Counts input and output
          tokens.
        </span>
        {#if fieldError("maxTokensPerPeriod")}
          <span class="field-error">{fieldError("maxTokensPerPeriod")}</span>
        {/if}
      </div>

      <div class="field">
        <label for="hardSpendLimitUsd">Hard spend limit (USD)</label>
        <input
          type="number"
          id="hardSpendLimitUsd"
          name="hardSpendLimitUsd"
          placeholder="Unlimited"
          min="0"
          step="0.01"
          value={fieldValue(
            form?.values?.hardSpendLimitUsd,
            data.limits?.hardSpendLimitUsd,
          )}
        />
        <span class="field-hint">
          Absolute ceiling. All new requests are rejected when this is reached.
          This limit is cumulative and does not reset per period.
        </span>
        {#if fieldError("hardSpendLimitUsd")}
          <span class="field-error">{fieldError("hardSpendLimitUsd")}</span>
        {/if}
      </div>

      <button type="submit" class="btn-save">Save Limits</button>
    </form>
  </div>
</section>

<style>
  .settings {
    max-width: 48rem;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }

  .subtitle {
    color: var(--color-text-muted);
    margin-bottom: 1.5rem;
  }

  h2 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }

  .alert {
    padding: 0.75rem 1rem;
    border-radius: 0.375rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .alert-error {
    background: var(--color-error-bg);
    color: var(--color-error-text-strong);
    border: 1px solid var(--color-error-border);
  }

  .alert-success {
    background: var(--color-success-bg);
    color: var(--color-success-text);
    border: 1px solid var(--color-success-border);
  }

  /* Usage summary */
  .usage-section {
    margin-bottom: 2rem;
  }

  .usage-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 1rem;
  }

  .usage-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
  }

  .usage-label {
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    color: var(--color-text-muted);
  }

  .usage-value {
    font-size: 1.25rem;
    font-weight: 600;
  }

  .usage-cap {
    font-size: 0.875rem;
    font-weight: 400;
    color: var(--color-text-muted);
  }

  .usage-date {
    font-size: 0.875rem;
  }

  /* Config form */
  .config-section {
    border-top: 1px solid var(--color-border);
    padding-top: 1.5rem;
  }

  .config-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    max-width: 24rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label {
    font-size: 0.875rem;
    font-weight: 500;
  }

  input {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    font-size: 0.875rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  input:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .field-error {
    font-size: 0.8125rem;
    color: var(--color-error-text);
  }

  .field-hint {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    line-height: 1.3;
  }

  .btn-save {
    align-self: flex-start;
    background: var(--color-primary);
    color: var(--color-on-primary);
    border: none;
    padding: 0.5rem 1.25rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-save:hover {
    background: var(--color-primary-hover);
  }
</style>
