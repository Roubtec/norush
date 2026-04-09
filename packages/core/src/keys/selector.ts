/**
 * Key Selector — picks API keys in priority order with failover support.
 *
 * Given a user's keys for a provider, returns an ordered list of candidate
 * keys for batch submission. The Batch Manager walks this list, attempting
 * each key in turn until one succeeds or all are exhausted.
 *
 * Key selection rules:
 *   1. Sort by `priority` ascending (lower = preferred).
 *   2. The first key is always a candidate (even if `failoverEnabled` is false).
 *   3. Subsequent keys are only candidates if they have `failoverEnabled: true`.
 *   4. Revoked keys (revokedAt !== null) are excluded.
 */

import type { ProviderName } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A stored API key record as seen by the selector. */
export interface ApiKeyInfo {
  id: string;
  provider: ProviderName;
  label: string;
  priority: number;
  failoverEnabled: boolean;
  revokedAt: Date | null;
}

/** A key candidate returned by the selector. */
export interface KeyCandidate {
  id: string;
  label: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Errors that should trigger failover to the next API key.
 *
 * Failover is only for rate limit (429) or credit/quota exhaustion errors.
 * Other errors (network, 500, malformed request) do NOT trigger failover
 * because a different key would not help.
 */
export function isFailoverEligibleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  // HTTP 429 — rate limited
  if (message.includes("429") || message.includes("rate limit")) {
    return true;
  }

  // Credit / quota / billing exhaustion
  if (
    message.includes("insufficient") ||
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("billing") ||
    message.includes("exceeded")
  ) {
    return true;
  }

  // Check for a `status` property on the error (common in SDK errors).
  const statusError = error as Error & { status?: number; statusCode?: number };
  if (statusError.status === 429 || statusError.statusCode === 429) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Key selection
// ---------------------------------------------------------------------------

/**
 * Select candidate keys for batch submission, ordered by priority.
 *
 * Returns an ordered list of keys to try. The first entry is the primary key;
 * subsequent entries are failover candidates (only those with `failoverEnabled`).
 *
 * @param keys - All of a user's keys for a given provider.
 * @returns Ordered list of candidate keys (may be empty if all are revoked).
 */
export function selectKeys(keys: ApiKeyInfo[]): KeyCandidate[] {
  // Filter out revoked keys.
  const active = keys.filter((k) => k.revokedAt === null);

  if (active.length === 0) return [];

  // Sort by priority ascending (lower = preferred).
  const sorted = [...active].sort((a, b) => a.priority - b.priority);

  const candidates: KeyCandidate[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const key = sorted[i];

    if (i === 0) {
      // Primary key is always a candidate.
      candidates.push({
        id: key.id,
        label: key.label,
        priority: key.priority,
      });
    } else if (key.failoverEnabled) {
      // Subsequent keys only if failover is enabled on them.
      candidates.push({
        id: key.id,
        label: key.label,
        priority: key.priority,
      });
    }
  }

  return candidates;
}
