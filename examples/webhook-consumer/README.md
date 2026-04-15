# Webhook Consumer Example

A minimal HTTP server that receives norush webhook deliveries and verifies their HMAC-SHA256 signatures.

## Overview

When you configure a `webhookUrl` on a norush request, the engine will POST the completed result to that URL.
This example shows how to receive and verify those deliveries.

## Setup

```bash
cd examples/webhook-consumer
npm install
```

## Run

```bash
# Set the webhook secret (must match the one used when enqueuing requests)
export WEBHOOK_SECRET=my-shared-secret

# Start the webhook receiver on port 4000
node server.js
```

## Usage with norush

When enqueuing a request, include the callback URL and secret:

```typescript
await engine.enqueue({
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  params: {
    messages: [{ role: 'user', content: 'Hello!' }],
    max_tokens: 256,
  },
  callbackUrl: 'http://localhost:4000/webhook',
  webhookSecret: 'my-shared-secret',
});
```

## Payload Format

The webhook POST body is JSON:

```json
{
  "norush_id": "01ABC...",
  "status": "succeeded",
  "response": { "content": "..." },
  "input_tokens": 12,
  "output_tokens": 48,
  "model": "claude-sonnet-4-6",
  "provider": "claude"
}
```

The `X-Norush-Signature` header contains `sha256=<hex>`, where the hex is the HMAC-SHA256 of the timestamp-bound signing input `"${X-Norush-Timestamp}.${body}"`.
Verify the signature against that signing input rather than the raw body to prevent replay attacks.
