<!--
  Composer: message input area with model/provider selector.

  Designed to feel low-pressure — "Submit for later" button label.
  The user selects a provider + model, types a message, and submits.
-->
<script>
  /**
   * @type {{
   *   onSubmit: (data: { provider: string; model: string; content: string }) => Promise<void>;
   *   disabled?: boolean;
   * }}
   */
  let { onSubmit, disabled = false } = $props();

  let provider = $state("claude");
  let model = $state("claude-sonnet-4-20250514");
  let content = $state("");
  let submitting = $state(false);
  let error = $state(/** @type {string | null} */ (null));

  /** Model options per provider. */
  const MODEL_OPTIONS = /** @type {Record<string, Array<{ value: string; label: string }>>} */ ({
    claude: [
      { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
      { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
    ],
    openai: [
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "gpt-4o-mini", label: "GPT-4o mini" },
    ],
  });

  let modelOptions = $derived(MODEL_OPTIONS[provider] ?? []);

  /** Reset model selection when provider changes. */
  $effect(() => {
    const opts = MODEL_OPTIONS[provider];
    if (opts && opts.length > 0) {
      model = opts[0].value;
    }
  });

  async function handleSubmit() {
    const trimmed = content.trim();
    if (!trimmed || submitting || disabled) return;

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
        {#each modelOptions as opt}
          <option value={opt.value}>{opt.label}</option>
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
      disabled={submitting || disabled || content.trim().length === 0}
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
    color: #dc2626;
    background: #fef2f2;
    border: 1px solid #fecaca;
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
    color: #fff;
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
