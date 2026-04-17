<!--
  Composer: message input area with model/provider selector.

  Designed to feel low-pressure — "Submit for later" button label.
  The user selects a provider + model, types a message, and submits.

  Model options now come from the server via the `catalog` prop — the
  page load fetches them from the provider_catalog table with hardcoded
  fallbacks in $lib/models.ts. Only `active` and `legacy` models are
  offered for selection; `deprecated` and `retired` rows are hidden to
  avoid the Composer letting a user queue a batch that will then fail at
  the provider after the model retires. See task 5-01 for rationale.
-->
<script>
  import { FALLBACK_MODELS } from "$lib/models.js";

  /**
   * @typedef {{
   *   provider: "claude" | "openai";
   *   model: string;
   *   displayLabel: string;
   *   lifecycleState: "active" | "legacy" | "deprecated" | "retired";
   *   deprecatedAt: string | null;
   *   retiresAt: string | null;
   *   replacementModel: string | null;
   * }} CatalogModel
   */

  /**
   * @type {{
   *   onSubmit: (data: { provider: string; model: string; content: string }) => Promise<void>;
   *   disabled?: boolean;
   *   catalog?: CatalogModel[];
   * }}
   */
  let { onSubmit, disabled = false, catalog = [] } = $props();

  /**
   * Selectable models: anything from the server catalog or fallback seed
   * that is currently `active` or `legacy`. `deprecated` and `retired`
   * rows are filtered out — see the comment block at the top of the file.
   */
  let selectableCatalog = $derived(buildSelectableCatalog(catalog));

  /**
   * @param {CatalogModel[]} list
   * @returns {CatalogModel[]}
   */
  function buildSelectableCatalog(list) {
    const source = list.length > 0 ? list : FALLBACK_MODELS;

    // First pass: filter to active/legacy only.
    /** @type {CatalogModel[]} */
    const candidates = [];
    for (const entry of source) {
      if (entry.lifecycleState !== "active" && entry.lifecycleState !== "legacy") continue;
      candidates.push({
        provider: entry.provider,
        model: entry.model,
        displayLabel: entry.displayLabel,
        lifecycleState: entry.lifecycleState,
        deprecatedAt: entry.deprecatedAt ?? null,
        retiresAt: entry.retiresAt ?? null,
        replacementModel: entry.replacementModel ?? null,
      });
    }

    // Second pass: deduplicate by (provider, displayLabel). When the live
    // catalog contains both a dated slug (e.g. claude-haiku-4-5-20251001)
    // and the undated alias (claude-haiku-4-5), they share the same display
    // label. Prefer the undated alias (the provider's "latest" pointer); if
    // both are dated, keep the one with the later date suffix.
    /** @type {Map<string, CatalogModel>} */
    const byLabel = new Map();
    for (const entry of candidates) {
      const key = `${entry.provider}::${entry.displayLabel}`;
      const existing = byLabel.get(key);
      if (!existing) {
        byLabel.set(key, entry);
        continue;
      }
      // Prefer the undated alias (no -YYYYMMDD suffix).
      const existingDated = /-\d{8}$/.test(existing.model);
      const entryDated = /-\d{8}$/.test(entry.model);
      if (existingDated && !entryDated) {
        byLabel.set(key, entry);
      } else if (entryDated && !existingDated) {
        // keep existing (undated)
      } else if (entry.model > existing.model) {
        // Both dated or both undated — lexicographic compare picks the later date.
        byLabel.set(key, entry);
      }
    }

    return [...byLabel.values()];
  }

  /** @type {"claude" | "openai"} */
  let provider = $state("claude");
  let content = $state("");
  let submitting = $state(false);
  let error = $state(/** @type {string | null} */ (null));

  let modelOptions = $derived(
    selectableCatalog.filter((m) => m.provider === provider),
  );

  /** Default model: first active option for the current provider (or empty). */
  // svelte-ignore state_referenced_locally — initial snapshot is fine; the $effect below keeps the selection valid as the catalog or provider changes.
  let model = $state(pickDefault("claude", selectableCatalog));

  /**
   * @param {string} prov
   * @param {CatalogModel[]} list
   */
  function pickDefault(prov, list) {
    const active = list.find((m) => m.provider === prov && m.lifecycleState === "active");
    if (active) return active.model;
    const any = list.find((m) => m.provider === prov);
    return any ? any.model : "";
  }

  /** Reset model selection when provider changes or the catalog shifts. */
  $effect(() => {
    const opts = selectableCatalog.filter((m) => m.provider === provider);
    // If the currently selected model is still valid, keep it.
    if (opts.some((m) => m.model === model)) return;
    model = pickDefault(provider, selectableCatalog);
  });

  async function handleSubmit() {
    const trimmed = content.trim();
    if (!trimmed || submitting || disabled || !model) return;

    error = null;
    submitting = true;

    try {
      await onSubmit({ provider, model, content: trimmed });
      content = "";
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to submit message";
    } finally {
      submitting = false;
    }
  }

  /**
   * Handle keyboard shortcuts in the textarea.
   * @param {KeyboardEvent} e
   */
  function handleKeydown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }
</script>

<div class="composer">
  {#if error}
    <div class="composer-error">{error}</div>
  {/if}

  <div class="selectors">
    <div class="field">
      <label for="composer-provider">Provider</label>
      <select id="composer-provider" bind:value={provider} disabled={submitting || disabled}>
        <option value="claude">Anthropic (Claude)</option>
        <option value="openai">OpenAI</option>
      </select>
    </div>

    <div class="field">
      <label for="composer-model">Model</label>
      <select id="composer-model" bind:value={model} disabled={submitting || disabled}>
        {#each modelOptions as opt (opt.model)}
          <option value={opt.model}>
            {opt.displayLabel}{opt.lifecycleState === "legacy" ? " (legacy)" : ""}
          </option>
        {/each}
      </select>
    </div>
  </div>

  <div class="input-row">
    <textarea
      class="message-input"
      bind:value={content}
      placeholder="Type your prompt here..."
      rows="3"
      disabled={submitting || disabled}
      onkeydown={handleKeydown}
    ></textarea>
  </div>

  <div class="submit-row">
    <span class="hint">Ctrl+Enter to submit</span>
    <button
      class="btn-submit"
      onclick={handleSubmit}
      disabled={submitting || disabled || content.trim().length === 0 || !model}
    >
      {submitting ? "Submitting..." : "Submit for later"}
    </button>
  </div>
</div>

<style>
  .composer {
    border-top: 1px solid var(--color-border);
    padding: 1rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .composer-error {
    font-size: 0.875rem;
    color: var(--color-error-text);
    background: var(--color-error-bg);
    border: 1px solid var(--color-error-border);
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
  }

  .selectors {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
  }

  select {
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  select:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .input-row {
    display: flex;
  }

  .message-input {
    flex: 1;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    font-size: 0.9375rem;
    font-family: inherit;
    line-height: 1.5;
    resize: vertical;
    min-height: 4rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  .message-input:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }

  .message-input::placeholder {
    color: var(--color-text-muted);
  }

  .submit-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .btn-submit {
    background: var(--color-primary);
    color: var(--color-on-primary);
    border: none;
    padding: 0.5rem 1.25rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-submit:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
