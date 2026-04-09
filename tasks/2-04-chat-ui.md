# Build Chat UI with Message Submission and Result Polling

## Why this task exists

The chat interface is the primary user experience of norush.chat — users write messages, norush batches them, and responses appear when ready.
This task delivers the core interaction loop.

## Scope

**Included:**
- Chat page: message list with visual states (queued, batched, processing, succeeded, failed)
- Message composer: text input with model/provider selector and submit button
- Server API routes: submit message, list messages with results
- HTTP polling for new results (30–60s interval)
- Per-conversation or single-thread view (start simple: one thread per user, conversations can be added later)
- Cost savings indicator (show estimated savings vs real-time API usage)

**Out of scope:**
- Webhook / broker mode (Phase 3)
- Push notifications / email notifications (can be added incrementally)
- Multi-conversation management (can be added incrementally)
- Message editing or deletion

## Context and references

- PLAN.md Section 5.1 (norush.chat) — user flow steps 3-6, "thought dump" UX, cost indicator
- PLAN.md Section 6.3 (Chat UI Polling) — HTTP polling at 30-60s, `GET /api/results?since={timestamp}`, no WebSocket
- PLAN.md Section 4.1 (Schema) — `requests` and `results` tables hold message/response data

## Target files or areas

```
packages/web/src/
├── routes/
│   └── (app)/
│       └── chat/
│           ├── +page.svelte          # Chat UI
│           └── +page.server.ts       # Load messages on page load
├── routes/
│   └── api/
│       ├── messages/
│       │   └── +server.ts           # POST: submit message; GET: list messages
│       └── results/
│           └── +server.ts           # GET: poll for new results since timestamp
├── lib/
│   ├── components/
│   │   ├── MessageList.svelte       # Scrollable message list
│   │   ├── MessageBubble.svelte     # Single message with status indicator
│   │   ├── Composer.svelte          # Input area with model selector
│   │   └── CostIndicator.svelte    # Savings display
│   └── server/
│       └── messages.ts              # Server-side message/result queries
packages/web/test/
└── chat/
    ├── messages-api.test.ts         # POST/GET /api/messages: validation, user scoping
    ├── results-api.test.ts          # GET /api/results: since-filter, user scoping
    └── cost-indicator.test.ts       # Savings calculation logic
```

## Implementation notes

- **Message submission (`POST /api/messages`):**
  - Authenticate user from session.
  - Validate input (non-empty, reasonable length).
  - Look up user's API key for the selected provider (decrypt from vault).
  - Call `norush.enqueue()` with the request params (model, messages array, etc.).
  - Return the created request with its `norush_id` and `status: 'queued'`.

- **Message list (`GET /api/messages`):**
  - Return user's requests with their results (joined), ordered by creation time.
  - Include request status and result content for completed requests.

- **Result polling (`GET /api/results?since={timestamp}`):**
  - Return results delivered after the given timestamp for the current user.
  - Client polls this every 30-60s using `$effect` + `setInterval` in the chat page.
  - When new results arrive, prepend/append them to the message list reactively.

- **Status indicators:** Use Svelte 5 runes (`$state`, `$derived`) for reactive message state. Show visual cues:
  - Queued: subtle pending icon
  - Processing: animated spinner
  - Succeeded: response text displayed
  - Failed: error message with option context

- **Cost indicator:** Calculate estimated savings: `(input_tokens + output_tokens) * standard_rate * 0.5`. Show as "You saved ~$X.XX using batch processing."

- **"Thought dump" UX:** The composer should feel low-pressure — no typing indicators, no "send" urgency. Perhaps a "Submit for later" button label instead of "Send."

### Dependencies

- Requires task 2-01 (SvelteKit scaffold).
- Requires task 2-02 (Auth — user must be logged in).
- Requires task 2-03 (API key vault — need keys for submission).
- Requires task 1-09 (norush engine — `enqueue()` and result delivery).

## Acceptance criteria

- User can type a message, select a model, and submit it.
- Submitted message appears in the chat list with `queued` status.
- Status updates as the request progresses (queued → batched → processing → succeeded).
- Completed responses display in the chat alongside the original message.
- HTTP polling fetches new results without page reload.
- Cost savings indicator shows estimated savings for completed messages.
- Failed requests show an error state.
- Unit tests cover: message submission (valid input, empty input, missing API key), message listing (user scoping, ordering), result polling (`since` filter, empty response), cost savings calculation.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- `pnpm test` passes all chat API and cost calculation tests.
- Submit a message → verify it appears as queued.
- Wait for batch processing → verify response appears (may need to manually trigger flush/tick in dev).
- Verify polling works: open two tabs, submit in one, result appears in both after poll interval.
- Verify cost indicator shows a number after results arrive.

## Review plan

- Verify polling interval is 30-60s (not too aggressive).
- Verify messages are scoped to the authenticated user (no cross-user leakage).
- Verify API key decryption happens server-side only.
- Check that Svelte 5 runes are used (no Svelte 4 stores or `$:` syntax).
- Confirm the UI handles the empty state (no messages yet) gracefully.
- Review test coverage for API routes: auth enforcement, input validation, cross-user isolation.
