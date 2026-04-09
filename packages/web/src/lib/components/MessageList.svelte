<!--
  MessageList: scrollable container for chat messages.

  Renders messages in chronological order (oldest at top, newest at bottom)
  and auto-scrolls to the latest message.
-->
<script>
  import MessageBubble from "./MessageBubble.svelte";

  /**
   * @type {{
   *   messages: Array<{
   *     id: string;
   *     provider: string;
   *     model: string;
   *     params: Record<string, unknown>;
   *     status: string;
   *     createdAt: string;
   *     updatedAt: string;
   *     result: {
   *       id: string;
   *       response: Record<string, unknown>;
   *       stopReason: string | null;
   *       inputTokens: number | null;
   *       outputTokens: number | null;
   *       createdAt: string;
   *     } | null;
   *   }>;
   * }}
   */
  let { messages } = $props();

  /** Messages displayed oldest-first (reversed from the DESC query). */
  let orderedMessages = $derived([...messages].reverse());

  /** Reference to the scroll container for auto-scroll. */
  let scrollContainer = $state(/** @type {HTMLElement | null} */ (null));

  /** Scroll to bottom whenever messages change. */
  $effect(() => {
    // Access orderedMessages.length to subscribe to changes.
    if (orderedMessages.length && scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  });
</script>

<div class="message-list" bind:this={scrollContainer}>
  {#if orderedMessages.length === 0}
    <div class="empty-state">
      <p>No messages yet.</p>
      <p class="hint">Submit a prompt below to get started. Results will appear here when the batch completes.</p>
    </div>
  {:else}
    {#each orderedMessages as message (message.id)}
      <MessageBubble
        id={message.id}
        provider={message.provider}
        model={message.model}
        params={message.params}
        status={message.status}
        createdAt={message.createdAt}
        result={message.result}
      />
    {/each}
  {/if}
</div>

<style>
  .message-list {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 0;
    display: flex;
    flex-direction: column;
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    text-align: center;
    gap: 0.5rem;
    padding: 2rem;
  }

  .empty-state p {
    font-size: 1rem;
  }

  .hint {
    font-size: 0.875rem;
    max-width: 28rem;
  }
</style>
