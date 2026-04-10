/**
 * Example: run one processing cycle.
 *
 * Call this on a schedule (cron, Cloud Scheduler, etc.) to process
 * queued requests. Each tick() flushes the queue, polls batch statuses,
 * delivers completed results, and sweeps expired data.
 *
 * Usage:
 *   DATABASE_URL=postgres://... ANTHROPIC_API_KEY=sk-ant-... node tick.js
 */

import postgres from "postgres";
import { createNorush, PostgresStore, migrate, ConsoleTelemetry } from "@norush/core";

const sql = postgres(process.env.DATABASE_URL);

try {
  await migrate(sql);

  const store = new PostgresStore(sql);

  // Build provider config from environment
  const providers = {};
  if (process.env.ANTHROPIC_API_KEY) {
    providers.claude = [{ apiKey: process.env.ANTHROPIC_API_KEY }];
  }
  if (process.env.OPENAI_API_KEY) {
    providers.openai = [{ apiKey: process.env.OPENAI_API_KEY }];
  }

  const engine = createNorush({
    store,
    providers,
    telemetry: new ConsoleTelemetry(),
  });

  // Listen for events during this tick
  engine.on("batch:completed", (data) => {
    console.log(`Batch completed: ${data.batchId}`);
  });

  engine.on("delivery:success", (data) => {
    console.log(`Delivered result for request: ${data.requestId}`);
  });

  // Run one processing cycle
  console.log("Running tick...");
  await engine.tick();
  console.log("Tick complete.");
} finally {
  await sql.end();
}
