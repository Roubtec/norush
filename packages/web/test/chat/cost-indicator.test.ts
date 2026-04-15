/**
 * Tests for the cost savings calculation logic.
 *
 * Verifies that calculateSavings correctly computes the 50%
 * batch discount for different providers and token counts.
 */

import { describe, it, expect } from 'vitest';
import { calculateSavings } from '$lib/server/messages';

describe('calculateSavings', () => {
  it('calculates savings for Claude tokens', () => {
    // Claude rates: $3/M input, $15/M output
    // 1000 input + 500 output:
    // standard cost = 1000 * 3/1M + 500 * 15/1M = 0.003 + 0.0075 = 0.0105
    // savings (50%) = 0.00525
    const savings = calculateSavings('claude', 1000, 500);
    expect(savings).toBeCloseTo(0.00525, 5);
  });

  it('calculates savings for OpenAI tokens', () => {
    // OpenAI rates: $2.5/M input, $10/M output
    // 2000 input + 1000 output:
    // standard cost = 2000 * 2.5/1M + 1000 * 10/1M = 0.005 + 0.01 = 0.015
    // savings (50%) = 0.0075
    const savings = calculateSavings('openai', 2000, 1000);
    expect(savings).toBeCloseTo(0.0075, 5);
  });

  it('returns 0 for zero tokens', () => {
    const savings = calculateSavings('claude', 0, 0);
    expect(savings).toBe(0);
  });

  it('handles input-only tokens', () => {
    // 10000 input, 0 output
    // standard cost = 10000 * 3/1M = 0.03
    // savings = 0.015
    const savings = calculateSavings('claude', 10000, 0);
    expect(savings).toBeCloseTo(0.015, 5);
  });

  it('handles output-only tokens', () => {
    // 0 input, 10000 output
    // standard cost = 10000 * 15/1M = 0.15
    // savings = 0.075
    const savings = calculateSavings('claude', 0, 10000);
    expect(savings).toBeCloseTo(0.075, 5);
  });

  it('falls back to Claude rates for unknown provider', () => {
    const savings = calculateSavings('unknown-provider', 1000, 500);
    const claudeSavings = calculateSavings('claude', 1000, 500);
    expect(savings).toBe(claudeSavings);
  });

  it('handles large token counts', () => {
    // 1M input + 500K output for Claude
    // standard cost = 1M * 3/1M + 500K * 15/1M = 3 + 7.5 = 10.5
    // savings = 5.25
    const savings = calculateSavings('claude', 1_000_000, 500_000);
    expect(savings).toBeCloseTo(5.25, 2);
  });

  it('scales linearly with token count', () => {
    const savings1 = calculateSavings('openai', 100, 100);
    const savings10 = calculateSavings('openai', 1000, 1000);
    expect(savings10 / savings1).toBeCloseTo(10, 5);
  });
});
