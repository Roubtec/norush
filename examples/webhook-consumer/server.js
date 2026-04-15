/**
 * Example webhook consumer for norush.
 *
 * Receives POST /webhook with a JSON body and verifies the
 * HMAC-SHA256 signature from the X-Norush-Signature header.
 *
 * norush signs a timestamp-bound canonical string to prevent replay attacks:
 *   signing_input = "${X-Norush-Timestamp}.${raw_body}"
 *   X-Norush-Signature = "sha256=<HMAC-SHA256(secret, signing_input)>"
 *
 * Usage:
 *   WEBHOOK_SECRET=my-secret node server.js
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = parseInt(process.env.PORT ?? '4000', 10);
const SECRET = process.env.WEBHOOK_SECRET ?? '';

if (!SECRET) {
  console.warn('Warning: WEBHOOK_SECRET is not set. Signature verification will be skipped.');
}

/**
 * Verify a timestamp-bound HMAC-SHA256 signature using timing-safe comparison.
 *
 * @param {string} body - Raw request body string.
 * @param {string} timestamp - Value of the X-Norush-Timestamp header.
 * @param {string} signature - Value of the X-Norush-Signature header ("sha256=<hex>" or raw hex).
 */
function verifySignature(body, timestamp, signature) {
  if (!SECRET) return true; // Skip if no secret configured

  // Strip optional "sha256=" prefix so the header value can be passed directly.
  const hex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;

  // norush binds the timestamp to the body to prevent replay attacks.
  const signingInput = `${timestamp}.${body}`;
  const expected = createHmac('sha256', SECRET).update(signingInput).digest('hex');

  if (expected.length !== hex.length) return false;

  try {
    return timingSafeEqual(Buffer.from(hex, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Webhook endpoint
  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf-8');

    // Verify signature (timestamp-bound to prevent replays).
    const signature = req.headers['x-norush-signature'] ?? '';
    const timestamp = req.headers['x-norush-timestamp'] ?? '';
    if (SECRET && !verifySignature(body, timestamp, signature)) {
      console.error('Signature verification failed!');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Parse and process the result.
    // Payload shape: { norush_id, status, response, input_tokens, output_tokens, model, provider }
    try {
      const payload = JSON.parse(body);
      console.log('Received norush result:');
      console.log('  norush ID:', payload.norush_id);
      console.log('  Status:', payload.status);
      console.log('  Provider:', payload.provider, payload.model);
      if (payload.response) {
        console.log('  Response:', JSON.stringify(payload.response).slice(0, 200));
      }

      // --- Your processing logic here ---
      // e.g., save to database, trigger downstream job, send notification

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    } catch (err) {
      console.error('Failed to parse webhook body:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Webhook consumer listening on http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/webhook to deliver results`);
});
