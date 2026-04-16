<!--
  API Key management settings page.

  Lists existing API keys (masked) and provides forms to add or delete keys.
  All sensitive operations happen server-side via SvelteKit form actions.
-->
<script>
  import { enhance } from "$app/forms";

  let { data, form } = $props();

  const providers = [
    { value: "claude", label: "Anthropic (Claude)" },
    { value: "openai", label: "OpenAI" },
  ];

  /** Extract error message for a specific field from the form response.
   * @param {string} field
   */
  function fieldError(field) {
    if (!form?.errors) return null;
    const err = form.errors.find((e) => e.field === field);
    return err?.message ?? null;
  }
</script>

<svelte:head>
  <title>API Keys - norush chat</title>
</svelte:head>

<section class="settings">
  <h1>API Keys</h1>
  <p class="subtitle">
    Manage your LLM provider API keys. Keys are encrypted at rest and never
    displayed in full after storage.
  </p>

  <!-- Error loading keys -->
  {#if data.loadError}
    <div class="alert alert-error">{data.loadError}</div>
  {/if}

  <!-- Success message -->
  {#if form?.success}
    <div class="alert alert-success">API key updated successfully.</div>
  {/if}

  <!-- General form error (shown for both add and delete actions) -->
  {#if form?.errors}
    {#each form.errors.filter((e) => e.field === "general" || e.field === "keyId") as err}
      <div class="alert alert-error">{err.message}</div>
    {/each}
  {/if}

  <!-- Existing keys table -->
  <div class="keys-section">
    <h2>Your Keys</h2>

    {#if data.keys.length === 0}
      <p class="empty-state">
        No API keys configured yet. Add one below to get started.
      </p>
    {:else}
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Label</th>
              <th>Key</th>
              <th>Priority</th>
              <th>Failover</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each data.keys as key}
              <tr>
                <td class="provider">{key.provider}</td>
                <td>{key.label}</td>
                <td class="masked-key"><code>{key.maskedKey}</code></td>
                <td class="center">{key.priority}</td>
                <td class="center">{key.failoverEnabled ? "Yes" : "No"}</td>
                <td>
                  <form method="POST" action="?/delete" use:enhance>
                    <input type="hidden" name="keyId" value={key.id} />
                    <button type="submit" class="btn-delete">Delete</button>
                  </form>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <!-- Add key form -->
  <div class="add-section">
    <h2>Add API Key</h2>

    <form method="POST" action="?/add" use:enhance class="add-form">
      <div class="field">
        <label for="provider">Provider</label>
        <select
          id="provider"
          name="provider"
          required
          value={form?.values?.provider ?? ""}
        >
          <option value="" disabled>Select a provider</option>
          {#each providers as p}
            <option value={p.value}>{p.label}</option>
          {/each}
        </select>
        {#if fieldError("provider")}
          <span class="field-error">{fieldError("provider")}</span>
        {/if}
      </div>

      <div class="field">
        <label for="label">Label</label>
        <input
          type="text"
          id="label"
          name="label"
          placeholder="e.g. Primary, Backup"
          required
          maxlength="100"
          value={form?.values?.label ?? ""}
        />
        {#if fieldError("label")}
          <span class="field-error">{fieldError("label")}</span>
        {/if}
      </div>

      <div class="field">
        <label for="apiKey">API Key</label>
        <input
          type="password"
          id="apiKey"
          name="apiKey"
          placeholder="sk-..."
          required
          autocomplete="off"
        />
        {#if fieldError("apiKey")}
          <span class="field-error">{fieldError("apiKey")}</span>
        {/if}
      </div>

      <div class="field">
        <label for="priority">Priority</label>
        <input
          type="number"
          id="priority"
          name="priority"
          value={form?.values?.priority ?? 0}
          min="0"
          max="99"
        />
        {#if fieldError("priority")}
          <span class="field-error">{fieldError("priority")}</span>
        {/if}
        <span class="field-hint">Lower number = tried first</span>
      </div>

      <button type="submit" class="btn-add">Add Key</button>
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

  /* Keys table */
  .keys-section {
    margin-bottom: 2rem;
  }

  .empty-state {
    color: var(--color-text-muted);
    font-style: italic;
  }

  .table-wrapper {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  th {
    text-align: left;
    font-weight: 600;
    padding: 0.5rem 0.75rem;
    border-bottom: 2px solid var(--color-border);
    white-space: nowrap;
  }

  td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  .provider {
    text-transform: capitalize;
  }

  .masked-key code {
    font-size: 0.8125rem;
    background: var(--color-surface-muted);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
  }

  .center {
    text-align: center;
  }

  .btn-delete {
    background: none;
    border: 1px solid var(--color-error-border-strong);
    color: var(--color-error-text);
    padding: 0.25rem 0.75rem;
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 0.8125rem;
  }

  .btn-delete:hover {
    background: var(--color-error-bg);
  }

  /* Add form */
  .add-section {
    border-top: 1px solid var(--color-border);
    padding-top: 1.5rem;
  }

  .add-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
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

  input,
  select {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    font-size: 0.875rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  input:focus,
  select:focus {
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
  }

  .btn-add {
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

  .btn-add:hover {
    background: var(--color-primary-hover);
  }
</style>
