/**
 * Example: enqueue requests for deferred processing.
 *
 * Run once (or whenever you have new work) to add requests to the queue.
 * They will be processed on the next tick() invocation.
 *
 * Usage:
 *   DATABASE_URL=postgres://... ANTHROPIC_API_KEY=sk-ant-... node enqueue.js
 */

import postgres from 'postgres';
import { createNorush, PostgresStore, migrate, ConsoleTelemetry } from '@norush/core';

const sql = postgres(process.env.DATABASE_URL);

try {
  // Run migrations (idempotent)
  await migrate(sql);

  const store = new PostgresStore(sql);
  const engine = createNorush({
    store,
    providers: {
      claude: [{ apiKey: process.env.ANTHROPIC_API_KEY }],
    },
    telemetry: new ConsoleTelemetry(),
  });

  // Enqueue a batch of requests
  const prompts = [
    'Summarise the key benefits of batch processing for LLM APIs.',
    'Explain the difference between synchronous and asynchronous API calls.',
    'What are the cost implications of using deferred processing?',
  ];

  for (const content of prompts) {
    const request = await engine.enqueue({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      params: {
        messages: [{ role: 'user', content }],
        max_tokens: 1024,
      },
    });
    console.log(`Queued: ${request.id} — "${content.slice(0, 50)}..."`);
  }

  console.log(`\nEnqueued ${prompts.length} requests. Run 'node tick.js' to process.`);
} finally {
  await sql.end();
}
