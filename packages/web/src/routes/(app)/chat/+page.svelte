<!--
  Chat page: message list with submission and result polling.

  Uses Svelte 5 runes for reactive state management.
  Polls /api/results every 30s for new results.
-->
<script>
  import MessageList from "$lib/components/MessageList.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import { calculateSavings } from "$lib/savings.js";
  import { FALLBACK_MODELS } from "$lib/models.js";

  let { data } = $props();

  /**
   * @typedef {{
   *   id: string;
   *   provider: string;
   *   model: string;
   *   params: Record<string, unknown>;
   *   status: string;
   *   createdAt: string;
   *   updatedAt: string;
   *   result: {
   *     id: string;
   *     response: Record<string, unknown>;
   *     stopReason: string | null;
   *     inputTokens: number | null;
   *     outputTokens: number | null;
   *     createdAt: string;
   *   } | null;
   * }} Message
   */

  // svelte-ignore state_referenced_locally — intentional snapshot; polling handles updates.
  const initialMessages = data.messages;
  // svelte-ignore state_referenced_locally
  const initialLoadedAt = data.loadedAt;

  /** Reactive message list, updated via polling and submission. */
  let messages = $state(/** @type {Message[]} */ ([...initialMessages]));

  /** Last poll timestamp to fetch only new results. */
  let lastPollAt = $state(initialLoadedAt);

  /**
   * Per-(provider, model) rate lookup built from the same effective catalog
   * source used by the model picker. When the server load falls back to an
   * empty catalog, keep savings aligned by using the same fallback models
   * instead of dropping back to provider-level default pricing.
   */
  // svelte-ignore state_referenced_locally — catalog is loaded once at page-load time; per-catalog refresh requires a reload anyway.
  const effectiveCatalog =
    Array.isArray(data.catalog) && data.catalog.length > 0 ? data.catalog : [...FALLBACK_MODELS];
  const ratesOverride = buildRatesOverride(effectiveCatalog);

  /**
   * @param {{ provider: string; model: string; inputUsdPerToken: number | null; outputUsdPerToken: number | null }[]} catalog
   */
  function buildRatesOverride(catalog) {
    const idx = new Map();
    for (const entry of catalog) {
      if (entry.inputUsdPerToken != null && entry.outputUsdPerToken != null) {
        idx.set(`${entry.provider}::${entry.model}`, {
          input: entry.inputUsdPerToken,
          output: entry.outputUsdPerToken,
        });
      }
    }
    return {
      /**
       * @param {string} provider
       * @param {string} model
       */
      getRate(provider, model) {
        return idx.get(`${provider}::${model}`) ?? null;
      },
    };
  }

  /** Whether we have any pending/in-progress messages that need polling. */
  let hasPending = $derived(
    messages.some(
      (m) =>
        m.status === "queued" ||
        m.status === "batched" ||
        m.status === "processing",
    ),
  );

  /** Total savings across all completed messages. */
  let totalSavings = $derived(
    messages.reduce(
      (sum, m) =>
        sum +
        calculateSavings(
          m.provider,
          m.result?.inputTokens,
          m.result?.outputTokens,
          { model: m.model, rates: ratesOverride },
        ),
      0,
    ),
  );

  /**
   * Submit a new message via the API.
   * @param {{ provider: string; model: string; content: string }} input
   */
  async function handleSubmit(input) {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    const body = await res.json();

    if (!res.ok) {
      const errorMsg =
        body.errors
          ?.map((/** @type {{ message: string }} */ e) => e.message)
          .join(". ") ?? "Failed to submit message";
      throw new Error(errorMsg);
    }

    // Add the new message to the list (at the beginning, since list is DESC).
    /** @type {Message} */
    const newMessage = {
      id: body.id,
      provider: body.provider,
      model: body.model,
      params: { messages: [{ role: "user", content: input.content }] },
      status: body.status,
      createdAt: body.createdAt,
      updatedAt: body.createdAt,
      result: null,
    };
    messages = [newMessage, ...messages];
  }

  /** Poll for new results and update the message list. */
  async function pollResults() {
    try {
      const res = await fetch(
        `/api/results?since=${encodeURIComponent(lastPollAt)}`,
      );
      if (!res.ok) return;

      const body = await res.json();
      lastPollAt = body.polledAt;

      if (!body.results || body.results.length === 0) return;

      // Update messages with new results/status changes.
      const updatedMessages = [...messages];
      for (const update of body.results) {
        const idx = updatedMessages.findIndex((m) => m.id === update.requestId);
        if (idx !== -1) {
          updatedMessages[idx] = {
            ...updatedMessages[idx],
            status: update.status,
            result: update.result ?? updatedMessages[idx].result,
          };
        }
      }
      messages = updatedMessages;
    } catch {
      // Silently ignore poll failures — will retry on next interval.
    }
  }

  // Set up polling interval (30s) — only polls when there are pending messages.
  $effect(() => {
    const POLL_INTERVAL_MS = 30_000;
    const interval = setInterval(() => {
      if (hasPending) {
        pollResults();
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  });
</script>

<svelte:head>
  <title>Chat - norush chat</title>
</svelte:head>

<section class="chat-page">
  <div class="chat-header">
    <h1>Chat</h1>
    {#if totalSavings > 0}
      <span
        class="total-savings"
        title="Total estimated savings from batch processing"
      >
        Total saved: ~${totalSavings.toFixed(2)}
      </span>
    {/if}
  </div>

  {#if data.loadError}
    <div class="alert alert-error">{data.loadError}</div>
  {/if}

  <MessageList {messages} rates={ratesOverride} />

  <Composer onSubmit={handleSubmit} catalog={data.catalog ?? []} />
</section>

<style>
  .chat-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - var(--header-height) - 4rem - 3.5rem);
    max-width: 48rem;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
  }

  .total-savings {
    font-size: 0.8125rem;
    color: #166534;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
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
</style>
