<!--
  MessageBubble: renders a single message with status indicator.

  Shows the user's prompt, the current processing status, and
  the LLM response when available.
-->
<script>
  import CostIndicator from "./CostIndicator.svelte";

  /**
   * @type {{
   *   id: string;
   *   provider: string;
   *   model: string;
   *   params: Record<string, unknown>;
   *   status: string;
   *   createdAt: string;
   *   result: {
   *     id: string;
   *     response: Record<string, unknown>;
   *     stopReason: string | null;
   *     inputTokens: number | null;
   *     outputTokens: number | null;
   *     createdAt: string;
   *   } | null;
   *   rates?: { getRate(provider: string, model: string): { input: number; output: number } | null | undefined } | null;
   * }}
   */
  let { id, provider, model, params, status, createdAt, result, rates = null } = $props();

  /** Extract the user's message content from params. */
  let userContent = $derived((() => {
    const messages = params?.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (typeof last === "object" && last !== null && "content" in last) {
        return String(last.content);
      }
    }
    return JSON.stringify(params);
  })());

  /** Extract the assistant's response text. */
  let assistantContent = $derived((() => {
    if (!result?.response) return null;
    const resp = result.response;

    // Anthropic response format
    if (Array.isArray(resp.content)) {
      return resp.content
        .filter((/** @type {Record<string, unknown>} */ b) => b.type === "text")
        .map((/** @type {{ text: string }} */ b) => b.text)
        .join("");
    }

    // OpenAI response format
    if (Array.isArray(resp.choices)) {
      const choice = resp.choices[0];
      if (typeof choice === "object" && choice !== null && "message" in choice) {
        const msg = /** @type {{ content: string }} */ (choice.message);
        return msg.content;
      }
    }

    return JSON.stringify(resp);
  })());

  let formattedTime = $derived(
    new Date(createdAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
</script>

<article class="message-bubble" data-status={status} {id}>
  <!-- User message -->
  <div class="user-message">
    <div class="message-header">
      <span class="model-tag">{model}</span>
      <span class="status-badge">
        {status.replace("_", " ")}
      </span>
      <time class="timestamp">{formattedTime}</time>
    </div>
    <p class="content user-content">{userContent}</p>
  </div>

  <!-- Assistant response -->
  {#if status === "succeeded" && assistantContent}
    <div class="assistant-message">
      <p class="content assistant-content">{assistantContent}</p>
      {#if result}
        <div class="result-meta">
          {#if result.inputTokens != null && result.outputTokens != null}
            <span class="token-count">
              {result.inputTokens.toLocaleString()} in / {result.outputTokens.toLocaleString()} out
            </span>
            <CostIndicator
              {provider}
              {model}
              {rates}
              inputTokens={result.inputTokens}
              outputTokens={result.outputTokens}
            />
          {/if}
        </div>
      {/if}
    </div>
  {:else if status === "failed" || status === "failed_final"}
    <div class="error-message">
      <p class="content error-content">
        Request failed.
        {#if result?.response?.error}
          {typeof result.response.error === "string" ? result.response.error : JSON.stringify(result.response.error)}
        {:else}
          The batch request did not succeed. You may try again.
        {/if}
      </p>
    </div>
  {:else if status !== "succeeded"}
    <div class="pending-message">
      <p class="content pending-content">
        {#if status === "queued"}
          Waiting to be batched...
        {:else if status === "batched"}
          Added to batch, waiting for submission...
        {:else if status === "processing"}
          Processing by {provider}...
        {:else}
          Status: {status}
        {/if}
      </p>
    </div>
  {/if}
</article>

<style>
  .message-bubble {
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    padding: 1rem;
    margin-bottom: 0.75rem;
    background: var(--color-surface);
  }

  .message-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }

  .model-tag {
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--color-surface-muted);
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    color: var(--color-text-muted);
  }

  .status-badge {
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid currentColor;
    padding: 0.0625rem 0.375rem;
    border-radius: 9999px;
    text-transform: capitalize;
    color: var(--color-status-queued);
  }

  .message-bubble[data-status="queued"] .status-badge {
    color: var(--color-status-queued);
  }
  .message-bubble[data-status="batched"] .status-badge {
    color: var(--color-status-batched);
  }
  .message-bubble[data-status="processing"] .status-badge {
    color: var(--color-status-processing);
  }
  .message-bubble[data-status="succeeded"] .status-badge {
    color: var(--color-status-succeeded);
  }
  .message-bubble[data-status="failed"] .status-badge {
    color: var(--color-status-failed);
  }
  .message-bubble[data-status="expired"] .status-badge {
    color: var(--color-status-expired);
  }
  .message-bubble[data-status="failed_final"] .status-badge {
    color: var(--color-status-failed-final);
  }
  .message-bubble[data-status="canceled"] .status-badge {
    color: var(--color-status-canceled);
  }

  .timestamp {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }

  .content {
    font-size: 0.9375rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .user-content {
    color: var(--color-text);
  }

  .assistant-message {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-border);
  }

  .assistant-content {
    color: var(--color-text);
  }

  .result-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }

  .token-count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .error-message {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-error-border);
  }

  .error-content {
    color: var(--color-error-text);
    font-size: 0.875rem;
  }

  .pending-message {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px dashed var(--color-border);
  }

  .pending-content {
    color: var(--color-text-muted);
    font-style: italic;
    font-size: 0.875rem;
  }
</style>
