/**
 * Standalone worker entry point.
 *
 * Reads config from environment variables, creates a norush engine with
 * PostgresStore, calls start(), and handles SIGTERM/SIGINT for graceful
 * shutdown.
 *
 * Usage:
 *   node packages/core/dist/worker.js
 *
 * Required environment variables:
 *   DATABASE_URL — PostgreSQL connection string.
 *
 * Optional environment variables:
 *   ANTHROPIC_API_KEY        — Anthropic API key (enables Claude adapter).
 *   OPENAI_API_KEY           — OpenAI API key (enables OpenAI adapter).
 *   NORUSH_FLUSH_INTERVAL_MS — Flush interval in ms (default: 300000).
 *   NORUSH_POLL_INTERVAL_MS  — Poll interval in ms (default: 60000).
 *   NORUSH_DELIVERY_INTERVAL_MS — Delivery tick interval in ms (default: 5000).
 *   NORUSH_MAX_REQUESTS      — Max requests per flush (default: 1000).
 *   NORUSH_RETENTION_DEFAULT — Default retention policy (default: '7d').
 *   NORUSH_RETENTION_HARD_CAP_DAYS — Hard cap in days (default: 90).
 *   NORUSH_RETENTION_INTERVAL_MS — Retention sweep interval (default: 3600000).
 */

import postgres from 'postgres';
import { createNorush, type NorushConfig } from './norush.js';
import { migrate } from './store/migrate.js';
import { PostgresStore } from './store/postgres.js';
import { ConsoleTelemetry } from './telemetry/console.js';
import type { ProviderName } from './types.js';
import type { ProviderKeyConfig } from './config/types.js';
import {
  parseRetentionPolicy,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
} from './engine/retention-worker.js';

// ---------------------------------------------------------------------------
// Environment parsing
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function optionalEnvInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
  }
  return parsed;
}

function positiveEnvInt(name: string, fallback: number): number {
  const value = optionalEnvInt(name, fallback);
  if (value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${value}`);
  }
  return value;
}

function parseRequiredRetentionPolicy(name: string, fallback: RetentionPolicy): RetentionPolicy {
  const raw = process.env[name] ?? fallback;
  const parsed = parseRetentionPolicy(raw);
  if (parsed === null) {
    throw new Error(`Invalid ${name}: '${raw}'. Expected 'on_ack' or 'Nd' (e.g. '7d', '30d').`);
  }
  return raw as RetentionPolicy;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = requiredEnv('DATABASE_URL');

  // Build provider config from environment.
  const providers: Partial<Record<ProviderName, ProviderKeyConfig[]>> = {};

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providers.claude = [{ apiKey: anthropicKey, label: 'primary' }];
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    providers.openai = [{ apiKey: openaiKey, label: 'primary' }];
  }

  if (!anthropicKey && !openaiKey) {
    console.warn(
      'Warning: No provider API keys configured. ' + 'Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY.',
    );
  }

  const sql = postgres(databaseUrl, {
    onnotice: (notice) => {
      console.log(`[postgres] ${notice.severity ?? 'NOTICE'} ${JSON.stringify(notice)}`);
    },
  });

  // Run database migrations before anything else to ensure the schema is
  // up-to-date, even if the worker starts before the first web request.
  const applied = await migrate(sql);
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }

  const store = new PostgresStore(sql);
  const telemetry = new ConsoleTelemetry();

  const config: NorushConfig = {
    store,
    providers,
    batching: {
      flushIntervalMs: optionalEnvInt('NORUSH_FLUSH_INTERVAL_MS', 300_000),
      maxRequests: optionalEnvInt('NORUSH_MAX_REQUESTS', 1000),
    },
    polling: {
      intervalMs: optionalEnvInt('NORUSH_POLL_INTERVAL_MS', 60_000),
    },
    delivery: {
      tickIntervalMs: optionalEnvInt('NORUSH_DELIVERY_INTERVAL_MS', 5_000),
    },
    retention: {
      defaultPolicy: parseRequiredRetentionPolicy(
        'NORUSH_RETENTION_DEFAULT',
        DEFAULT_RETENTION_POLICY,
      ),
      hardCapDays: positiveEnvInt('NORUSH_RETENTION_HARD_CAP_DAYS', 90),
      intervalMs: positiveEnvInt('NORUSH_RETENTION_INTERVAL_MS', 3_600_000),
    },
    telemetry,
  };

  const engine = createNorush(config);

  // Graceful shutdown handler.
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}, shutting down gracefully...`);

    // Force-exit after 30 s in case shutdown hangs (e.g., stuck provider call).
    const forceExitTimer = setTimeout(() => {
      console.error('Shutdown timed out after 30 s, forcing exit.');
      process.exit(1);
    }, 30_000);
    // Don't let the timer prevent normal exit.
    forceExitTimer.unref();

    try {
      await engine.stop();
      // Close the database connection pool after the engine has flushed so
      // no in-flight queries are cut off.
      await sql.end();
      clearTimeout(forceExitTimer);
      console.log('Engine stopped. Exiting.');
    } catch (error) {
      console.error('Error during shutdown:', error);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }

    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Start the engine.
  engine.start();
  console.log('norush worker started.');
}

main().catch((error) => {
  console.error('Fatal error starting norush worker:', error);
  process.exit(1);
});
