/**
 * Retention worker — periodic scrubbing of expired content.
 *
 * Enforces configurable data lifecycle policies by replacing prompt/response
 * content with tombstones after the retention period expires. Metadata (IDs,
 * timestamps, token counts, status) is preserved for billing and analytics.
 *
 * Supports per-user retention policies:
 * - `on_ack`  — scrub immediately after webhook 2xx ACK
 * - `1d`      — scrub 1 day after creation
 * - `7d`      — scrub after 7 days (default)
 * - `30d`     — scrub after 30 days
 * - Custom    — any `Nd` duration in days
 *
 * An operator-configured hard cap (e.g., 90 days) is enforced regardless of
 * user preference — user values are clamped via Math.min.
 */

import type { Store } from "../interfaces/store.js";
import type { TelemetryHook } from "../interfaces/telemetry.js";
import { NoopTelemetry } from "../telemetry/noop.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported retention policy values. */
export type RetentionPolicy = "on_ack" | `${number}d`;

/**
 * Resolves the retention policy for a given user.
 *
 * Implementations may read from `user_settings`, an in-memory cache, or
 * return a static default. Return `null` to use the worker's default policy.
 */
export type RetentionPolicyResolver = (
  userId: string,
) => RetentionPolicy | null | Promise<RetentionPolicy | null>;

/** Configuration for the retention worker. */
export interface RetentionWorkerOptions {
  store: Store;

  /** Resolves per-user retention policy. Defaults to returning null (use defaultPolicy). */
  policyResolver?: RetentionPolicyResolver;

  /** Default retention policy when no user-specific policy is set. Default: '7d'. */
  defaultPolicy?: RetentionPolicy;

  /** Operator hard cap in days. User policies are clamped to this. Default: 90. */
  hardCapDays?: number;

  /** How often the retention loop runs in milliseconds. Default: 3600000 (1 hour). */
  intervalMs?: number;

  /** Optional telemetry hook. */
  telemetry?: TelemetryHook;
}

/** Result of a single retention sweep. */
export interface RetentionSweepResult {
  /** Total number of records scrubbed across all users. */
  totalScrubbed: number;
  /** Number of records scrubbed by hard cap enforcement. */
  hardCapScrubbed: number;
  /** Number of records scrubbed by per-user policy. */
  policyScrubbed: number;
  /** Number of event log entries scrubbed. */
  eventLogScrubbed: number;
  /** Number of errors encountered during the sweep. */
  errors: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = "7d";
export const DEFAULT_HARD_CAP_DAYS = 90;
export const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a retention policy string into a number of days.
 *
 * Returns `0` for both `on_ack` and `0d` — both policies require at least one
 * successful delivery attempt before scrubbing, making them equivalent.
 * Returns `null` for unrecognised values.
 */
export function parseRetentionPolicy(
  policy: string,
): number | null {
  if (policy === "on_ack") return 0;

  const match = /^(\d+)d$/.exec(policy);
  if (!match) return null;

  const days = parseInt(match[1], 10);
  if (days < 0 || !Number.isFinite(days)) return null;
  return days;
}

/**
 * Compute the cutoff date for a policy, clamping to the operator hard cap.
 *
 * For `on_ack` (0 days), returns `null` — on_ack scrubbing is handled
 * separately since it depends on delivery status, not age.
 */
export function computeCutoffDate(
  policyDays: number,
  hardCapDays: number,
  now: Date = new Date(),
): Date | null {
  if (policyDays === 0) return null; // on_ack handled separately
  const effectiveDays = Math.min(policyDays, hardCapDays);
  return new Date(now.getTime() - effectiveDays * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// RetentionWorker
// ---------------------------------------------------------------------------

export class RetentionWorker {
  private readonly store: Store;
  private readonly policyResolver: RetentionPolicyResolver;
  private readonly defaultPolicy: RetentionPolicy;
  private readonly hardCapDays: number;
  private readonly intervalMs: number;
  private readonly telemetry: TelemetryHook;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guard to prevent concurrent sweeps. */
  private sweeping = false;

  constructor(options: RetentionWorkerOptions) {
    this.store = options.store;
    this.policyResolver = options.policyResolver ?? (() => null);
    this.defaultPolicy = options.defaultPolicy ?? DEFAULT_RETENTION_POLICY;
    this.hardCapDays = options.hardCapDays ?? DEFAULT_HARD_CAP_DAYS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.telemetry = options.telemetry ?? new NoopTelemetry();
  }

  // -- Lifecycle ------------------------------------------------------------

  /** Start the periodic retention sweep loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        this.telemetry.event("retention_sweep_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    // Unref so the timer doesn't prevent process exit.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /** Stop the periodic retention sweep loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -- Core sweep logic -----------------------------------------------------

  /**
   * Run a single retention sweep.
   *
   * Steps:
   * 1. Enforce hard cap — scrub everything older than the operator's hard cap.
   * 2. Per-user policy scrubbing — for each user with unscrubbed content, apply
   *    their retention policy.
   * 3. Event log scrubbing — scrub details on all events whose parent entity
   *    (request or result) has been scrubbed, covering both hard-cap and
   *    per-user policy scrubbing from this and prior sweeps.
   *
   * Returns an empty result immediately if a sweep is already in progress.
   */
  async sweep(now: Date = new Date()): Promise<RetentionSweepResult> {
    // Guard against concurrent sweeps (e.g. a slow sweep overlapping the timer).
    if (this.sweeping) {
      return {
        totalScrubbed: 0,
        hardCapScrubbed: 0,
        policyScrubbed: 0,
        eventLogScrubbed: 0,
        errors: 0,
      };
    }

    this.sweeping = true;

    const result: RetentionSweepResult = {
      totalScrubbed: 0,
      hardCapScrubbed: 0,
      policyScrubbed: 0,
      eventLogScrubbed: 0,
      errors: 0,
    };

    try {
      // Step 1: Hard cap enforcement.
      try {
        const hardCapCutoff = new Date(
          now.getTime() - this.hardCapDays * MS_PER_DAY,
        );
        const hardCapCount = await this.store.scrubExpiredContent(hardCapCutoff);
        result.hardCapScrubbed = hardCapCount;
        result.totalScrubbed += hardCapCount;

        if (hardCapCount > 0) {
          this.telemetry.counter("retention.hard_cap_scrubbed", hardCapCount);
          this.telemetry.event("retention_hard_cap", {
            scrubbed: hardCapCount,
            cutoff: hardCapCutoff.toISOString(),
          });
        }
      } catch (err) {
        result.errors++;
        this.telemetry.event("retention_hard_cap_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 2: Per-user policy scrubbing.
      try {
        const policyResult = await this.scrubByPolicy(now);
        result.policyScrubbed = policyResult.scrubbed;
        result.totalScrubbed += policyResult.scrubbed;
        result.errors += policyResult.errors;
      } catch (err) {
        result.errors++;
        this.telemetry.event("retention_policy_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 3: Event log scrubbing — covers entities scrubbed by either the
      // hard cap (step 1) or per-user policy (step 2), including any that were
      // scrubbed in previous sweeps but whose event logs were not yet cleaned up.
      try {
        result.eventLogScrubbed =
          await this.store.scrubEventLogsForScrubbedContent();
      } catch (err) {
        result.errors++;
        this.telemetry.event("retention_event_log_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.sweeping = false;
    }

    if (result.totalScrubbed > 0 || result.eventLogScrubbed > 0) {
      this.telemetry.event("retention_sweep_complete", {
        totalScrubbed: result.totalScrubbed,
        hardCapScrubbed: result.hardCapScrubbed,
        policyScrubbed: result.policyScrubbed,
        eventLogScrubbed: result.eventLogScrubbed,
        errors: result.errors,
      });
    }

    return result;
  }

  /**
   * Apply per-user retention policies.
   *
   * Fetches distinct user IDs with unscrubbed content, resolves each user's
   * retention policy, and scrubs content accordingly. Event log scrubbing is
   * handled separately in sweep() step 3 so it covers hard-cap-scrubbed users
   * too.
   */
  private async scrubByPolicy(
    now: Date,
  ): Promise<{ scrubbed: number; errors: number }> {
    let scrubbed = 0;
    let errors = 0;

    // Get distinct user IDs that have unscrubbed content.
    const userIds = await this.store.getDistinctUserIdsWithUnscrubbedContent();

    for (const userId of userIds) {
      try {
        // Resolve this user's retention policy.
        const rawPolicy = await this.policyResolver(userId);
        const policy = rawPolicy ?? this.defaultPolicy;

        const policyDays = parseRetentionPolicy(policy);
        if (policyDays === null) {
          this.telemetry.event("retention_invalid_policy", {
            userId,
            policy,
          });
          errors++;
          continue;
        }

        if (policyDays === 0) {
          // on_ack / 0d: scrub delivered content (requires prior delivery attempt).
          const count = await this.store.scrubDeliveredContent(userId);
          scrubbed += count;

          if (count > 0) {
            this.telemetry.counter("retention.on_ack_scrubbed", count, {
              userId,
            });
          }
        } else {
          // Time-based: compute cutoff, clamped to hard cap.
          const cutoff = computeCutoffDate(policyDays, this.hardCapDays, now);
          if (!cutoff) continue;

          const count = await this.store.scrubContentForUser(userId, cutoff);
          scrubbed += count;

          if (count > 0) {
            this.telemetry.counter("retention.policy_scrubbed", count, {
              userId,
              policy,
            });
          }
        }
      } catch (err) {
        errors++;
        this.telemetry.event("retention_user_error", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { scrubbed, errors };
  }
}
