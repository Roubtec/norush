/**
 * Example webhook consumer for norush.
 *
 * Receives POST /webhook with a JSON body and verifies the
 * HMAC-SHA256 signature from the x-norush-signature header.
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
 * Verify an HMAC-SHA256 signature using timing-safe comparison.
 */
function verifySignature(body, signature) {
  if (!SECRET) return true; // Skip if no secret configured
  const expected = createHmac('sha256', SECRET).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
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

    // Verify signature
    const signature = req.headers['x-norush-signature'] ?? '';
    if (SECRET && !verifySignature(body, signature)) {
      console.error('Signature verification failed!');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Parse and process the result
    try {
      const payload = JSON.parse(body);
      console.log('Received norush result:');
      console.log('  Request ID:', payload.requestId);
      console.log('  Success:', payload.success);
      if (payload.response) {
        console.log('  Response:', JSON.stringify(payload.response).slice(0, 200));
      }
      if (payload.error) {
        console.log('  Error:', payload.error);
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
