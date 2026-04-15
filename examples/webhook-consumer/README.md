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

When enqueuing a request, include the webhook URL and secret:

```typescript
await engine.enqueue({
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  params: {
    messages: [{ role: 'user', content: 'Hello!' }],
    max_tokens: 256,
  },
  webhookUrl: 'http://localhost:4000/webhook',
  webhookSecret: 'my-shared-secret',
});
```

## Payload Format

The webhook POST body is JSON:

```json
{
  "requestId": "01ABC...",
  "response": { "content": "..." },
  "success": true
}
```

The `x-norush-signature` header contains the HMAC-SHA256 hex digest of the body, computed with your shared secret.
