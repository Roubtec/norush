# Implement Webhook Delivery with HMAC Signing

## Why this task exists

Broker mode users receive results via webhook POST instead of polling the API.
This task adds webhook delivery to the Result Router's delivery pipeline with optional HMAC-SHA256 signing.

## Scope

**Included:**
- Webhook delivery in the delivery worker: POST result to `callback_url` on the request
- HMAC-SHA256 signing: `X-Norush-Signature` header when the request has a `webhook_secret`
- At-least-once delivery with exponential backoff (10s → 20s → 40s → ... cap 10min, max 5 attempts)
- Delivery headers: `X-Norush-Attempt`, `X-Norush-Request-Id`, `Content-Type: application/json`
- `norush_id` included in every payload for consumer-side deduplication
- Re-delivery API endpoint: `POST /api/v1/requests/:id/redeliver`

**Out of scope:**
- Webhook URL validation / test ping (nice-to-have, can add later)
- Webhook delivery logs UI (can add later)

## Context and references

- PLAN.md Section 6.5 (Webhook Delivery) — HMAC signing, delivery guarantees, retry schedule, headers
- PLAN.md Section 6.2 (Result Pipeline) — Phase B delivery is where webhooks plug in
- PLAN.md Section 5.2 (Broker Mode) — user configures webhook endpoints

## Target files or areas

```
packages/core/src/
├── engine/
│   └── delivery-worker.ts    # Extend to support webhook delivery (alongside callbacks)
├── webhooks/
│   ├── deliver.ts            # HTTP POST with signing logic
│   └── sign.ts               # HMAC-SHA256 signature computation
packages/core/test/
└── webhooks/
    ├── deliver.test.ts
    └── sign.test.ts
packages/web/src/
└── routes/
    └── api/v1/requests/[id]/
        └── redeliver/
            └── +server.ts    # POST: re-trigger delivery
```

## Implementation notes

- **Delivery worker extension:** The delivery worker (from task 1-08) already reads undelivered results and invokes callbacks. Extend it to also POST to `callback_url` if one is set on the request.
- **HMAC signing:** `X-Norush-Signature = HMAC-SHA256(webhook_secret, JSON.stringify(body))`. Only include the header if the request has a `webhook_secret`. Use Node.js `crypto.createHmac()`.
- **Retry backoff:** On non-2xx response or network error, increment `delivery_attempts`, set `next_delivery_at = now + backoff`. Backoff formula: `min(10_000 * 2^(attempt-1), 600_000)`.
- **Payload format:**
  ```json
  {
    "norush_id": "...",
    "status": "succeeded",
    "response": { ... },
    "input_tokens": 123,
    "output_tokens": 456,
    "model": "claude-sonnet-4-6",
    "provider": "claude"
  }
  ```
- **Re-delivery endpoint:** Reset `delivery_status` to `pending`, `delivery_attempts` to 0, clear `next_delivery_at`. The delivery worker will pick it up on its next cycle.
- **Separate retry domain:** Webhook failures do not affect batch processing or result ingestion.

### Dependencies

- Requires task 1-08 (Result Router — delivery worker to extend).
- Requires task 3-01 (REST API — for the redeliver endpoint).

## Acceptance criteria

- Results with a `callback_url` trigger an HTTP POST to that URL.
- HMAC signature is correct and verifiable by the consumer.
- Unsigned webhooks work when no `webhook_secret` is set.
- Retry backoff follows the specified schedule.
- After max attempts, delivery is marked as `failed`.
- Re-delivery endpoint resets delivery state and triggers a new attempt.
- `X-Norush-Attempt` header reflects the current attempt number.
- Unit tests verify signing, delivery, retry, and failure scenarios.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Set up a test webhook receiver (e.g., httpbin or a local server). Submit a request with `callback_url` pointing to it. Verify the POST arrives with correct payload and signature.
- Simulate webhook failure (receiver returns 500) → verify retries happen at correct intervals.
- Call redeliver endpoint → verify a new delivery attempt is made.

## Review plan

- Verify HMAC computation matches PLAN.md Section 6.5 spec.
- Verify backoff formula matches PLAN.md Section 6.5 (10s → 20s → 40s → ... cap 10min).
- Check that webhook failures don't block result ingestion.
- Verify re-delivery is idempotent (calling twice doesn't double-deliver).
