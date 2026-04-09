/**
 * Delivery Worker — Phase B of the Result Pipeline.
 *
 * Reads undelivered results from the store and fans them out via registered
 * callback functions and/or an event emitter. Tracks delivery attempts with
 * exponential backoff retry.
 *
 * Delivery status lifecycle: `pending` -> `delivered` | `failed`
 *
 * Exponential backoff: 10s -> 20s -> 40s -> ... capped at 10min
 * After `maxDeliveryAttempts` (default 5): delivery_status -> `failed`
 *
 * Can run as a `setInterval` loop (long-running process) or be driven
 * externally via `worker.tick()` (serverless / cron).
 */

import type { Store } from "../interfaces/store.js";
import type { TelemetryHook } from "../interfaces/telemetry.js";
import type { Request, Result } from "../types.js";
import { NoopTelemetry } from "../telemetry/noop.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base delay for exponential backoff (10 seconds). */
const BASE_DELAY_MS = 10_000;

/** Maximum delay between retries (10 minutes). */
const MAX_DELAY_MS = 600_000;

/** Default maximum delivery attempts before marking as permanently failed. */
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;

/** Default number of undelivered results to fetch per tick. */
const DEFAULT_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback invoked for each result delivery.
 * Receives the result and the associated request (for callback URL, etc.).
 * Should throw on failure to trigger retry.
 */
export type DeliveryCallback = (
  result: Result,
  request: Request,
) => Promise<void>;

export type DeliveryEventName =
  | "delivery:success"
  | "delivery:failure"
  | "delivery:exhausted";

export type DeliveryEventHandler = (data: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeliveryWorkerOptions {
  store: Store;
  /** Maximum delivery attempts before permanent failure. Default: 5. */
  maxDeliveryAttempts?: number;
  /** Number of results to process per tick. Default: 50. */
  batchSize?: number;
  /** Tick interval in ms when using start(). Default: 5_000. */
  tickIntervalMs?: number;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
  /** Clock function for testability. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Delivery Worker
// ---------------------------------------------------------------------------

export class DeliveryWorker {
  private readonly store: Store;
  private readonly maxDeliveryAttempts: number;
  private readonly batchSize: number;
  private readonly tickIntervalMs: number;
  private readonly telemetry: TelemetryHook;
  private readonly now: () => Date;

  /** Registered delivery callbacks. */
  private callbacks: DeliveryCallback[] = [];

  /** Event listeners. */
  private listeners = new Map<
    DeliveryEventName,
    Set<DeliveryEventHandler>
  >();

  /** Interval handle for automatic tick loop. */
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Guard against concurrent tick execution. */
  private ticking = false;

  constructor(options: DeliveryWorkerOptions) {
    this.store = options.store;
    this.maxDeliveryAttempts =
      options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.tickIntervalMs = options.tickIntervalMs ?? 5_000;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Callback registration
  // -------------------------------------------------------------------------

  /**
   * Register a delivery callback. When a result is ready for delivery,
   * all registered callbacks are invoked. If any throws, delivery is
   * retried with backoff.
   */
  addCallback(callback: DeliveryCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove a previously registered callback.
   */
  removeCallback(callback: DeliveryCallback): void {
    this.callbacks = this.callbacks.filter((cb) => cb !== callback);
  }

  // -------------------------------------------------------------------------
  // Event emitter
  // -------------------------------------------------------------------------

  on(event: DeliveryEventName, handler: DeliveryEventHandler): void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
  }

  off(event: DeliveryEventName, handler: DeliveryEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(
    event: DeliveryEventName,
    data: Record<string, unknown>,
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch {
          // Swallow listener errors.
        }
      }
    }
    this.telemetry.event(event, data);
  }

  // -------------------------------------------------------------------------
  // Lifecycle (start/stop)
  // -------------------------------------------------------------------------

  /**
   * Start the automatic tick loop.
   * Idempotent — calling start() multiple times is safe.
   */
  start(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => {
      void this.tick().catch(() => {
        // Errors are captured in telemetry during tick.
      });
    }, this.tickIntervalMs);
    if (typeof this.tickTimer === "object" && "unref" in this.tickTimer) {
      this.tickTimer.unref();
    }
  }

  /**
   * Stop the automatic tick loop.
   */
  stop(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Tick (main loop body)
  // -------------------------------------------------------------------------

  /**
   * Execute one delivery cycle.
   *
   * Returns the number of results processed in this tick.
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.doTick();
    } finally {
      this.ticking = false;
    }
  }

  private async doTick(): Promise<number> {
    const results = await this.store.getUndeliveredResults(this.batchSize);
    let processed = 0;

    const now = this.now();

    for (const result of results) {
      // Skip results that are not yet due for (re)delivery.
      if (result.nextDeliveryAt && result.nextDeliveryAt > now) {
        continue;
      }

      // Skip results that have already exhausted delivery attempts.
      if (result.deliveryAttempts >= this.maxDeliveryAttempts) {
        continue;
      }

      await this.deliverResult(result);
      processed++;
    }

    if (processed > 0) {
      this.telemetry.counter("deliveries_attempted", processed);
    }

    return processed;
  }

  // -------------------------------------------------------------------------
  // Delivery logic
  // -------------------------------------------------------------------------

  private async deliverResult(result: Result): Promise<void> {
    // Look up the associated request (for callback URL, etc.).
    const request = await this.store.getRequest(result.requestId);
    if (!request) {
      // Orphaned result — mark as failed since we can't deliver without
      // a request context.
      await this.store.updateResult(result.id, {
        deliveryStatus: "failed",
        lastDeliveryError: `Request ${result.requestId} not found`,
      });
      return;
    }

    // If there are no callbacks and no callback URL on the request,
    // mark as no_target — nothing to deliver to.
    if (this.callbacks.length === 0 && !request.callbackUrl) {
      await this.store.updateResult(result.id, {
        deliveryStatus: "no_target",
      });
      return;
    }

    try {
      // Invoke all registered callbacks.
      for (const callback of this.callbacks) {
        await callback(result, request);
      }

      // Delivery succeeded — mark delivered.
      await this.store.markDelivered(result.id);

      this.emit("delivery:success", {
        resultId: result.id,
        requestId: result.requestId,
        batchId: result.batchId,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      const attempts = result.deliveryAttempts + 1;

      if (attempts >= this.maxDeliveryAttempts) {
        // Exhausted all attempts — mark permanently failed.
        await this.store.updateResult(result.id, {
          deliveryStatus: "failed",
          deliveryAttempts: attempts,
          lastDeliveryError: message,
        });

        this.emit("delivery:exhausted", {
          resultId: result.id,
          requestId: result.requestId,
          batchId: result.batchId,
          attempts,
          error: message,
        });

        this.telemetry.counter("delivery_failures", 1);
      } else {
        // Schedule retry with exponential backoff.
        const nextDeliveryAt = this.computeNextDeliveryAt(attempts);

        await this.store.updateResult(result.id, {
          deliveryAttempts: attempts,
          lastDeliveryError: message,
          nextDeliveryAt,
        });

        this.emit("delivery:failure", {
          resultId: result.id,
          requestId: result.requestId,
          batchId: result.batchId,
          attempt: attempts,
          nextDeliveryAt: nextDeliveryAt.toISOString(),
          error: message,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Backoff calculation
  // -------------------------------------------------------------------------

  /**
   * Compute the next delivery time using exponential backoff.
   *
   * Formula: min(BASE_DELAY * 2^(attempt-1), MAX_DELAY)
   * With attempt=1: 10s, attempt=2: 20s, attempt=3: 40s, attempt=4: 80s, ...
   * Capped at 10 minutes.
   */
  private computeNextDeliveryAt(attempt: number): Date {
    const delay = Math.min(
      BASE_DELAY_MS * Math.pow(2, attempt - 1),
      MAX_DELAY_MS,
    );
    return new Date(this.now().getTime() + delay);
  }
}

// ---------------------------------------------------------------------------
// Exported constants for testing
// ---------------------------------------------------------------------------

export { BASE_DELAY_MS, MAX_DELAY_MS, DEFAULT_MAX_DELIVERY_ATTEMPTS };
