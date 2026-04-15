import type { PollContext } from '../types.js';

/**
 * Polling strategy interface.
 *
 * Determines the delay before the next status check for a submitted batch.
 * Implementations can use fixed intervals, exponential backoff, or adaptive
 * strategies based on provider, elapsed time, and poll count.
 */
export interface PollingStrategy {
  /** Return the delay in milliseconds before the next poll, given current state. */
  nextInterval(context: PollContext): number;
}
