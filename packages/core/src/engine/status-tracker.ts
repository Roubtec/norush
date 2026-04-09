/**
 * Status Tracker.
 *
 * Coordinates the poll loop, orphan recovery, and circuit breaker. Each tick:
 *
 *   1. Run orphan recovery (detect and re-submit crashed batches).
 *   2. Get in-flight batches from the store.
 *   3. For each batch, check if it's time to poll (using the polling strategy).
 *   4. Call provider.checkStatus() for due batches.
 *   5. Update batch status in store; emit lifecycle events.
 *   6. On terminal status, mark for result processing.
 *
 * Can run as a `setInterval` loop (long-running process) or be driven
 * externally via `tracker.tick()` (serverless / cron).
 */

import type { Store } from "../interfaces/store.js";
import type { Provider } from "../interfaces/provider.js";
import type { PollingStrategy } from "../interfaces/polling.js";
import type { TelemetryHook } from "../interfaces/telemetry.js";
import type {
  Batch,
  BatchStatus,
  PollContext,
  ProviderBatchRef,
  ProviderName,
} from "../types.js";
import { NoopTelemetry } from "../telemetry/noop.js";
import { getClampedStrategy } from "../polling/index.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";
import { OrphanRecovery } from "./orphan-recovery.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type StatusTrackerEventName =
  | "batch:submitted"
  | "batch:processing"
  | "batch:completed"
  | "batch:expired"
  | "batch:error"
  | "batch:failed"
  | "circuit_breaker:tripped";

export type StatusTrackerEventHandler = (data: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StatusTrackerOptions {
  store: Store;
  /** Map of provider name (or "provider::apiKeyId") to Provider adapter. */
  providers: Map<string, Provider>;
  /** Default polling strategy name. Default: 'linear'. */
  defaultPollingStrategy?: string;
  /** Default completion window in ms (for PollContext.expiresAt). Default: 86_400_000 (24h). */
  defaultCompletionWindowMs?: number;
  /** Tick interval in ms when using start(). Default: 60_000. */
  tickIntervalMs?: number;
  /** Orphan recovery grace period in ms. Default: 300_000 (5 min). */
  orphanGracePeriodMs?: number;
  /** Circuit breaker options. */
  circuitBreaker?: CircuitBreakerOptions;
  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
  /** Clock function for testability. */
  now?: () => Date;
}

/** Per-batch polling metadata tracked in memory. */
interface BatchPollState {
  lastPolledAt: Date | null;
  pollCount: number;
  strategy: PollingStrategy;
}

// ---------------------------------------------------------------------------
// Status Tracker
// ---------------------------------------------------------------------------

export class StatusTracker {
  private readonly store: Store;
  private readonly providers: Map<string, Provider>;
  private readonly defaultPollingStrategy: string;
  private readonly defaultCompletionWindowMs: number;
  private readonly tickIntervalMs: number;
  private readonly telemetry: TelemetryHook;
  private readonly now: () => Date;

  readonly circuitBreaker: CircuitBreaker;
  private readonly orphanRecovery: OrphanRecovery;

  /** In-memory poll state per batch (keyed by batch ID). */
  private pollStates = new Map<string, BatchPollState>();

  /** Event listeners. */
  private listeners = new Map<StatusTrackerEventName, Set<StatusTrackerEventHandler>>();

  /** Interval handle for automatic tick loop. */
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Guard against concurrent tick execution. */
  private ticking = false;

  constructor(options: StatusTrackerOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.defaultPollingStrategy = options.defaultPollingStrategy ?? "linear";
    this.defaultCompletionWindowMs = options.defaultCompletionWindowMs ?? 86_400_000;
    this.tickIntervalMs = options.tickIntervalMs ?? 60_000;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
    this.now = options.now ?? (() => new Date());

    this.circuitBreaker = new CircuitBreaker({
      ...options.circuitBreaker,
      telemetry: this.telemetry,
      now: () => this.now().getTime(),
    });

    this.orphanRecovery = new OrphanRecovery({
      store: this.store,
      providers: this.providers,
      gracePeriodMs: options.orphanGracePeriodMs,
      telemetry: this.telemetry,
      now: this.now,
    });
  }

  // -------------------------------------------------------------------------
  // Event emitter
  // -------------------------------------------------------------------------

  /**
   * Register a listener for a lifecycle event.
   */
  on(event: StatusTrackerEventName, handler: StatusTrackerEventHandler): void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
  }

  /**
   * Remove a listener.
   */
  off(event: StatusTrackerEventName, handler: StatusTrackerEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: StatusTrackerEventName, data: Record<string, unknown>): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch {
          // Swallow listener errors to avoid breaking the tick loop.
        }
      }
    }
    // Also emit via telemetry.
    this.telemetry.event(event, data);
  }

  // -------------------------------------------------------------------------
  // Lifecycle (start/stop)
  // -------------------------------------------------------------------------

  /**
   * Start the automatic tick loop (for long-running processes).
   * Idempotent — calling start() multiple times is safe.
   */
  start(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => {
      void this.tick().catch(() => {
        // Errors are captured in telemetry during tick.
      });
    }, this.tickIntervalMs);
    // Unref so the timer doesn't prevent process exit.
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
   * Execute one cycle of status tracking.
   *
   * Can be called externally for serverless/cron use or driven by start().
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.doTick();
    } finally {
      this.ticking = false;
    }
  }

  private async doTick(): Promise<void> {
    // Step 1: Orphan recovery.
    const orphanResult = await this.orphanRecovery.recover();
    if (orphanResult.recovered > 0 || orphanResult.failed > 0) {
      this.telemetry.counter("orphans_recovered", orphanResult.recovered);
      this.telemetry.counter("orphans_failed", orphanResult.failed);
    }

    // Report recovered orphans to circuit breaker (successful submissions).
    for (let i = 0; i < orphanResult.recovered; i++) {
      this.circuitBreaker.recordSuccess();
    }

    // Step 2: Get in-flight batches.
    const inFlight = await this.store.getInFlightBatches();

    // Step 3-5: Check each batch.
    for (const batch of inFlight) {
      await this.checkBatch(batch);
    }

    // Clean up poll states for batches no longer in-flight.
    this.cleanupPollStates(inFlight);
  }

  // -------------------------------------------------------------------------
  // Batch checking
  // -------------------------------------------------------------------------

  private async checkBatch(batch: Batch): Promise<void> {
    // Get or initialize poll state.
    const pollState = this.getOrCreatePollState(batch);

    // Check if it's time to poll this batch.
    if (!this.isDueForPoll(batch, pollState)) return;

    // In-flight batches should always have a provider batch ID.
    if (!batch.providerBatchId) return;

    const ref: ProviderBatchRef = {
      providerBatchId: batch.providerBatchId,
      provider: batch.provider,
    };

    // Resolve provider adapter.
    const adapter = this.resolveAdapter(batch.provider, batch.apiKeyId);
    if (!adapter) {
      this.telemetry.event("status_check_error", {
        batchId: batch.id,
        error: `No provider adapter found for ${batch.provider}`,
      });
      return;
    }

    // Call provider to check status.
    let newStatus: BatchStatus;
    try {
      newStatus = await adapter.checkStatus(ref);
    } catch (error) {
      this.telemetry.event("status_check_error", {
        batchId: batch.id,
        provider: batch.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      // Update poll state even on error (so we back off).
      pollState.lastPolledAt = this.now();
      pollState.pollCount++;
      return;
    }

    // Update poll state.
    pollState.lastPolledAt = this.now();
    pollState.pollCount++;

    this.telemetry.counter("batches_polled", 1, { provider: batch.provider });

    // Apply status transition.
    await this.applyStatusTransition(batch, newStatus);
  }

  /**
   * Determine if a batch is due for its next poll based on its strategy.
   */
  private isDueForPoll(batch: Batch, pollState: BatchPollState): boolean {
    if (pollState.lastPolledAt === null) return true;

    const context = this.buildPollContext(batch, pollState);
    const interval = pollState.strategy.nextInterval(context);
    const elapsed = this.now().getTime() - pollState.lastPolledAt.getTime();

    return elapsed >= interval;
  }

  /**
   * Build the PollContext for a batch.
   */
  private buildPollContext(batch: Batch, pollState: BatchPollState): PollContext {
    const submittedAt = batch.submittedAt ?? batch.createdAt;
    return {
      batchId: batch.id,
      provider: batch.provider,
      submittedAt,
      lastPolledAt: pollState.lastPolledAt,
      pollCount: pollState.pollCount,
      expiresAt: new Date(submittedAt.getTime() + this.defaultCompletionWindowMs),
    };
  }

  /**
   * Apply a status transition to a batch.
   */
  private async applyStatusTransition(
    batch: Batch,
    newStatus: BatchStatus,
  ): Promise<void> {
    // No change — nothing to do.
    if (newStatus === batch.status) return;

    const updates: Partial<Batch> = { status: newStatus };

    // Terminal statuses get an endedAt timestamp.
    if (isTerminalStatus(newStatus)) {
      updates.endedAt = this.now();
    }

    await this.store.updateBatch(batch.id, updates);

    // Emit lifecycle events.
    const eventData: Record<string, unknown> = {
      batchId: batch.id,
      provider: batch.provider,
      providerBatchId: batch.providerBatchId,
      previousStatus: batch.status,
      newStatus,
    };

    switch (newStatus) {
      case "submitted":
        this.emit("batch:submitted", eventData);
        break;
      case "processing":
        this.emit("batch:processing", eventData);
        break;
      case "ended":
        this.emit("batch:completed", eventData);
        break;
      case "expired":
        this.emit("batch:expired", eventData);
        break;
      case "failed":
        this.emit("batch:failed", eventData);
        this.circuitBreaker.recordFailure();
        if (!this.circuitBreaker.canSubmit()) {
          this.emit("circuit_breaker:tripped", {
            consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          });
        }
        break;
      case "cancelled":
        this.emit("batch:error", eventData);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Poll state management
  // -------------------------------------------------------------------------

  private getOrCreatePollState(batch: Batch): BatchPollState {
    let state = this.pollStates.get(batch.id);
    if (!state) {
      const strategyName = batch.pollingStrategy ?? this.defaultPollingStrategy;
      state = {
        lastPolledAt: null,
        pollCount: 0,
        strategy: getClampedStrategy(strategyName),
      };
      this.pollStates.set(batch.id, state);
    }
    return state;
  }

  /**
   * Remove poll states for batches no longer in-flight.
   */
  private cleanupPollStates(inFlightBatches: Batch[]): void {
    const inFlightIds = new Set(inFlightBatches.map((b) => b.id));
    for (const id of this.pollStates.keys()) {
      if (!inFlightIds.has(id)) {
        this.pollStates.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Provider adapter resolution
  // -------------------------------------------------------------------------

  private resolveAdapter(
    provider: ProviderName,
    apiKeyId: string,
  ): Provider | undefined {
    return (
      this.providers.get(`${provider}::${apiKeyId}`) ??
      this.providers.get(provider)
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTerminalStatus(status: BatchStatus): boolean {
  return (
    status === "ended" ||
    status === "expired" ||
    status === "failed" ||
    status === "cancelled"
  );
}
