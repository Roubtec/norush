/**
 * createNorush() — Factory function that assembles and returns the engine.
 *
 * Wires together all engine components: RequestQueue, BatchManager,
 * StatusTracker, ResultIngester, DeliveryWorker, and Repackager.
 *
 * Returns a public API with: enqueue(), flush(), tick(), start(), stop(),
 * and on(event, handler) for event subscription.
 */

import type { Store } from './interfaces/store.js';
import type { Provider } from './interfaces/provider.js';
import type { TelemetryHook } from './interfaces/telemetry.js';
import type { ProviderName, NewRequest, Request } from './types.js';
import type { ProviderKeyConfig, ResolvedConfig } from './config/types.js';
import { resolveConfig } from './config/resolve.js';
import { NoopTelemetry } from './telemetry/noop.js';
import { RequestQueue } from './engine/queue.js';
import { BatchManager } from './engine/batch-manager.js';
import { StatusTracker, type StatusTrackerEventName } from './engine/status-tracker.js';
import { ResultIngester } from './engine/result-ingester.js';
import {
  DeliveryWorker,
  type DeliveryCallback,
  type DeliveryEventName,
} from './engine/delivery-worker.js';
import { Repackager } from './engine/repackager.js';
import {
  RetentionWorker,
  type RetentionPolicy,
  type RetentionPolicyResolver,
} from './engine/retention-worker.js';
import { ClaudeAdapter } from './providers/claude.js';
import { OpenAIBatchAdapter } from './providers/openai-batch.js';

// ---------------------------------------------------------------------------
// Config for createNorush()
// ---------------------------------------------------------------------------

/**
 * Configuration passed to createNorush().
 *
 * Follows the shape from PLAN.md Section 3.4. Accepts either a pre-built
 * store or provider map, or configuration objects to build them automatically.
 */
export interface NorushConfig {
  /** Pre-built store instance (MemoryStore, PostgresStore, etc.). */
  store: Store;

  /**
   * Provider adapters. Can be:
   * - A pre-built Map<string, Provider> (keyed by provider name or "provider::apiKeyId").
   * - An object with provider names mapped to key configs, from which adapters are built.
   */
  providers: Map<string, Provider> | Partial<Record<ProviderName, ProviderKeyConfig[]>>;

  /** Batching configuration overrides (merged with defaults via resolveConfig). */
  batching?: {
    maxRequests?: number;
    maxBytes?: number;
    flushIntervalMs?: number;
  };

  /** Polling configuration overrides (merged with defaults via resolveConfig). */
  polling?: {
    intervalMs?: number;
    maxRetries?: number;
  };

  /** Delivery worker configuration. */
  delivery?: {
    /** Tick interval for delivery checks in ms. Default: 5000. */
    tickIntervalMs?: number;
    /** Maximum delivery attempts per result. Default: 5. */
    maxDeliveryAttempts?: number;
    /** Number of results to process per tick. Default: 50. */
    batchSize?: number;
  };

  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;

  /** Circuit breaker options. */
  circuitBreaker?: {
    threshold?: number;
    cooldownMs?: number;
  };

  /** Retention worker configuration. */
  retention?: {
    /** Default retention policy. Default: '7d'. */
    defaultPolicy?: RetentionPolicy;
    /** Operator hard cap in days. Default: 90. */
    hardCapDays?: number;
    /** Sweep interval in milliseconds. Default: 3600000 (1 hour). */
    intervalMs?: number;
    /** Per-user policy resolver. */
    policyResolver?: RetentionPolicyResolver;
  };

  /** Default polling strategy name (e.g., 'linear', 'eager'). Default: 'linear'. */
  defaultPollingStrategy?: string;
}

// ---------------------------------------------------------------------------
// NorushEngine — the public API surface
// ---------------------------------------------------------------------------

/** All event names the engine can emit. */
export type NorushEventName = StatusTrackerEventName | DeliveryEventName;

/** Unified event handler type. */
export type NorushEventHandler = (data: Record<string, unknown>) => void;

/** The public engine interface returned by createNorush(). */
export interface NorushEngine {
  /** Enqueue a request for deferred processing. */
  enqueue(request: NewRequest): Promise<Request>;

  /** Force-flush the request queue, forming and submitting batches. */
  flush(): Promise<void>;

  /** Run one cycle of all loops (flush, poll, deliver). For serverless/cron. */
  tick(): Promise<void>;

  /** Start all interval loops (flush, poll, deliver). For long-running processes. */
  start(): void;

  /** Stop all interval loops. Optionally performs a final flush. */
  stop(): Promise<void>;

  /** Register an event handler. */
  on(event: NorushEventName, handler: NorushEventHandler): void;

  /** Remove an event handler. */
  off(event: NorushEventName, handler: NorushEventHandler): void;

  /** Register a delivery callback. */
  addDeliveryCallback(callback: DeliveryCallback): void;

  /** Remove a delivery callback. */
  removeDeliveryCallback(callback: DeliveryCallback): void;

  /** The resolved configuration. */
  readonly config: ResolvedConfig;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a norush engine instance.
 *
 * Assembles all components, wires event flow (tracker completion -> ingester
 * -> delivery -> repackager), and returns a public API.
 */
export function createNorush(options: NorushConfig): NorushEngine {
  const telemetry = options.telemetry ?? new NoopTelemetry();

  // 1. Resolve config via resolveConfig().
  const resolvedConfig = resolveConfig(
    {},
    {
      batching: options.batching,
      polling: options.polling,
      circuitBreakerThreshold: options.circuitBreaker?.threshold,
      circuitBreakerCooldownMs: options.circuitBreaker?.cooldownMs,
    },
  );

  // 2. Store is provided directly.
  const store = options.store;

  // 3. Build provider adapter map.
  const providers = buildProviderMap(options.providers);

  // 4. Create all engine components.
  const batchManager = new BatchManager({
    store,
    providers,
    batching: resolvedConfig.batching,
    telemetry,
  });

  const queue = new RequestQueue({
    store,
    batching: resolvedConfig.batching,
    onFlush: () => batchManager.flush(),
    telemetry,
  });

  const statusTracker = new StatusTracker({
    store,
    providers,
    defaultPollingStrategy: options.defaultPollingStrategy,
    tickIntervalMs: resolvedConfig.polling.intervalMs,
    circuitBreaker: {
      threshold: resolvedConfig.circuitBreakerThreshold,
      cooldownMs: resolvedConfig.circuitBreakerCooldownMs,
    },
    telemetry,
  });

  const ingester = new ResultIngester({
    store,
    providers,
    telemetry,
  });

  const deliveryWorker = new DeliveryWorker({
    store,
    tickIntervalMs: options.delivery?.tickIntervalMs,
    maxDeliveryAttempts: options.delivery?.maxDeliveryAttempts,
    batchSize: options.delivery?.batchSize,
    telemetry,
  });

  const repackager = new Repackager({
    store,
    telemetry,
  });

  const retentionWorker = new RetentionWorker({
    store,
    defaultPolicy: options.retention?.defaultPolicy,
    hardCapDays: options.retention?.hardCapDays,
    intervalMs: options.retention?.intervalMs,
    policyResolver: options.retention?.policyResolver,
    telemetry,
  });

  // 5. Wire event flow: tracker completion -> ingester -> repackager.
  //
  // Fire-and-forget: the event emitter calls handlers synchronously and never
  // awaits their return value, so async work must be self-contained. This is
  // intentional — the ingest+repackage pipeline is crash-safe and idempotent,
  // so any in-flight work that is lost on shutdown will be re-triggered on the
  // next tick when the store still shows the batch as "ended".
  statusTracker.on('batch:completed', (data) => {
    const batchId = data.batchId as string;
    void (async () => {
      try {
        const batch = await store.getBatch(batchId);
        if (!batch) return;

        // Phase A: Ingest results from provider.
        await ingester.ingest(batch);

        // Phase B: Repackage failed/expired requests.
        const updatedBatch = await store.getBatch(batchId);
        if (updatedBatch) {
          await repackager.repackage(updatedBatch);
        }
      } catch (error) {
        telemetry.event('pipeline_error', {
          batchId,
          phase: 'ingest_or_repackage',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  // Also handle expired batches — repackage their requests.
  // Fire-and-forget for the same reasons as batch:completed above.
  statusTracker.on('batch:expired', (data) => {
    const batchId = data.batchId as string;
    void (async () => {
      try {
        const batch = await store.getBatch(batchId);
        if (!batch) return;

        // Mark all batched/processing requests as expired so repackager can
        // process them. Parallelise to avoid O(n) sequential round-trips.
        const requests = await store.getRequestsByBatchId(batchId);
        await Promise.all(
          requests
            .filter((req) => req.status === 'batched' || req.status === 'processing')
            .map((req) => store.updateRequest(req.id, { status: 'expired' })),
        );

        await repackager.repackage(batch);
      } catch (error) {
        telemetry.event('pipeline_error', {
          batchId,
          phase: 'expire_repackage',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  // 6. Return the public API.
  return {
    async enqueue(request: NewRequest): Promise<Request> {
      return queue.enqueue(request);
    },

    async flush(): Promise<void> {
      await queue.flush();
    },

    async tick(): Promise<void> {
      // Run one cycle of all loops: flush, poll, deliver, retention.
      await queue.tick();
      await statusTracker.tick();
      await deliveryWorker.tick();
      await retentionWorker.sweep();
    },

    start(): void {
      queue.start();
      statusTracker.start();
      deliveryWorker.start();
      retentionWorker.start();
    },

    async stop(): Promise<void> {
      await queue.stop({ finalFlush: true });
      statusTracker.stop();
      deliveryWorker.stop();
      retentionWorker.stop();
    },

    on(event: NorushEventName, handler: NorushEventHandler): void {
      // Route to the appropriate component.
      if (isStatusTrackerEvent(event)) {
        statusTracker.on(event, handler);
      } else if (isDeliveryEvent(event)) {
        deliveryWorker.on(event, handler);
      }
    },

    off(event: NorushEventName, handler: NorushEventHandler): void {
      if (isStatusTrackerEvent(event)) {
        statusTracker.off(event, handler);
      } else if (isDeliveryEvent(event)) {
        deliveryWorker.off(event, handler);
      }
    },

    addDeliveryCallback(callback: DeliveryCallback): void {
      deliveryWorker.addCallback(callback);
    },

    removeDeliveryCallback(callback: DeliveryCallback): void {
      deliveryWorker.removeCallback(callback);
    },

    get config(): ResolvedConfig {
      return resolvedConfig;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Map<string, Provider> from either a pre-built map or a config object.
 *
 * Keys in the provider map must be either `"provider"` (shared fallback) or
 * `"provider::userId"` (per-user adapter for multi-tenant routing). The engine
 * resolves adapters by trying `"provider::request.userId"` first, then falling
 * back to `"provider"`.
 *
 * When building from a config object, the first key for each provider is
 * registered as the shared fallback (`"claude"`, `"openai"`, etc.). This
 * covers single-key and single-tenant setups. For multi-tenant deployments
 * where different users should use different API keys, pass a pre-built
 * `Map<string, Provider>` with `"provider::userId"` entries instead.
 */
function buildProviderMap(
  input: Map<string, Provider> | Partial<Record<ProviderName, ProviderKeyConfig[]>>,
): Map<string, Provider> {
  if (input instanceof Map) {
    return input;
  }

  const map = new Map<string, Provider>();

  if (input.claude) {
    for (const keyConfig of input.claude) {
      const adapter = new ClaudeAdapter({ apiKey: keyConfig.apiKey });
      // Register as "claude" fallback only — the engine resolves adapters by
      // "claude::userId", not "claude::label". Per-user routing requires a
      // pre-built Map keyed by "claude::userId".
      if (!map.has('claude')) {
        map.set('claude', adapter);
      }
    }
  }

  if (input.openai) {
    for (const keyConfig of input.openai) {
      const adapter = new OpenAIBatchAdapter({ apiKey: keyConfig.apiKey });
      if (!map.has('openai')) {
        map.set('openai', adapter);
      }
    }
  }

  return map;
}

const STATUS_TRACKER_EVENTS: Set<string> = new Set([
  'batch:submitted',
  'batch:processing',
  'batch:completed',
  'batch:expired',
  'batch:error',
  'batch:failed',
  'circuit_breaker:tripped',
]);

const DELIVERY_EVENTS: Set<string> = new Set([
  'delivery:success',
  'delivery:failure',
  'delivery:exhausted',
]);

function isStatusTrackerEvent(event: string): event is StatusTrackerEventName {
  return STATUS_TRACKER_EVENTS.has(event);
}

function isDeliveryEvent(event: string): event is DeliveryEventName {
  return DELIVERY_EVENTS.has(event);
}
