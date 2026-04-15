import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve.js';
import type { EnvConfig, OperatorConfig, UserConfig } from '../config/types.js';

describe('resolveConfig', () => {
  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  describe('defaults', () => {
    it('returns library defaults when no tiers are provided', () => {
      const config = resolveConfig();

      expect(config.retentionDays).toBe(7);
      expect(config.batching).toEqual({
        maxRequests: 1000,
        maxBytes: 50_000_000,
        flushIntervalMs: 300_000,
      });
      expect(config.polling).toEqual({
        intervalMs: 60_000,
        maxRetries: 3,
      });
      expect(config.circuitBreakerThreshold).toBe(5);
      expect(config.circuitBreakerCooldownMs).toBe(600_000);
    });

    it('returns library defaults when all tiers are empty objects', () => {
      const config = resolveConfig({}, {}, {});

      expect(config.retentionDays).toBe(7);
      expect(config.batching.maxRequests).toBe(1000);
      expect(config.polling.intervalMs).toBe(60_000);
    });
  });

  // -------------------------------------------------------------------------
  // Operator overrides (Tier 2)
  // -------------------------------------------------------------------------

  describe('operator overrides', () => {
    it('uses operator defaults when user has no preferences', () => {
      const operator: OperatorConfig = {
        defaultRetentionDays: 30,
        batching: { maxRequests: 500, flushIntervalMs: 120_000 },
        polling: { intervalMs: 30_000, maxRetries: 5 },
        circuitBreakerThreshold: 10,
        circuitBreakerCooldownMs: 300_000,
      };

      const config = resolveConfig({}, operator);

      expect(config.retentionDays).toBe(30);
      expect(config.batching.maxRequests).toBe(500);
      expect(config.batching.flushIntervalMs).toBe(120_000);
      // maxBytes not set by operator, falls back to library default
      expect(config.batching.maxBytes).toBe(50_000_000);
      expect(config.polling.intervalMs).toBe(30_000);
      expect(config.polling.maxRetries).toBe(5);
      expect(config.circuitBreakerThreshold).toBe(10);
      expect(config.circuitBreakerCooldownMs).toBe(300_000);
    });

    it('uses operator maxRetentionDays as cap when no default is set', () => {
      const operator: OperatorConfig = {
        maxRetentionDays: 90,
        // no defaultRetentionDays, so library default (7) is used
      };

      const config = resolveConfig({}, operator);

      // Library default is 7, which is under the 90-day cap
      expect(config.retentionDays).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // User overrides (Tier 3)
  // -------------------------------------------------------------------------

  describe('user overrides', () => {
    it('uses user preferences when within operator caps', () => {
      const operator: OperatorConfig = {
        maxRetentionDays: 90,
        batching: { maxRequests: 2000 },
        polling: { maxRetries: 10 },
      };
      const user: UserConfig = {
        retentionDays: 30,
        batching: { maxRequests: 500 },
        polling: { maxRetries: 5 },
      };

      const config = resolveConfig({}, operator, user);

      expect(config.retentionDays).toBe(30);
      expect(config.batching.maxRequests).toBe(500);
      expect(config.polling.maxRetries).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Clamping
  // -------------------------------------------------------------------------

  describe('clamping', () => {
    it('clamps user retention to operator max', () => {
      const operator: OperatorConfig = { maxRetentionDays: 90 };
      const user: UserConfig = { retentionDays: 120 };

      const config = resolveConfig({}, operator, user);

      expect(config.retentionDays).toBe(90);
    });

    it('clamps user retention to exactly the operator max when equal', () => {
      const operator: OperatorConfig = { maxRetentionDays: 30 };
      const user: UserConfig = { retentionDays: 30 };

      const config = resolveConfig({}, operator, user);

      expect(config.retentionDays).toBe(30);
    });

    it('clamps user batching maxRequests to operator cap', () => {
      const operator: OperatorConfig = { batching: { maxRequests: 500 } };
      const user: UserConfig = { batching: { maxRequests: 2000 } };

      const config = resolveConfig({}, operator, user);

      expect(config.batching.maxRequests).toBe(500);
    });

    it('clamps user batching maxBytes to operator cap', () => {
      const operator: OperatorConfig = {
        batching: { maxBytes: 10_000_000 },
      };
      const user: UserConfig = { batching: { maxBytes: 100_000_000 } };

      const config = resolveConfig({}, operator, user);

      expect(config.batching.maxBytes).toBe(10_000_000);
    });

    it('clamps user polling maxRetries to operator cap', () => {
      const operator: OperatorConfig = { polling: { maxRetries: 3 } };
      const user: UserConfig = { polling: { maxRetries: 10 } };

      const config = resolveConfig({}, operator, user);

      expect(config.polling.maxRetries).toBe(3);
    });

    it('enforces minimum flush interval (user cannot flush more often than operator)', () => {
      const operator: OperatorConfig = {
        batching: { flushIntervalMs: 120_000 },
      };
      const user: UserConfig = { batching: { flushIntervalMs: 10_000 } };

      const config = resolveConfig({}, operator, user);

      // flushIntervalMs is clamped upward (user can't go below operator floor)
      expect(config.batching.flushIntervalMs).toBe(120_000);
    });

    it('enforces minimum polling interval (user cannot poll more aggressively than operator)', () => {
      const operator: OperatorConfig = { polling: { intervalMs: 30_000 } };
      const user: UserConfig = { polling: { intervalMs: 5_000 } };

      const config = resolveConfig({}, operator, user);

      // intervalMs is clamped upward (user can't go below operator floor)
      expect(config.polling.intervalMs).toBe(30_000);
    });

    it('allows user flush interval above operator floor', () => {
      const operator: OperatorConfig = {
        batching: { flushIntervalMs: 60_000 },
      };
      const user: UserConfig = { batching: { flushIntervalMs: 300_000 } };

      const config = resolveConfig({}, operator, user);

      expect(config.batching.flushIntervalMs).toBe(300_000);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles operator max retention lower than library default', () => {
      const operator: OperatorConfig = { maxRetentionDays: 3 };
      // no user config, so library default (7) would be used
      // but operator cap is 3, so it should clamp

      const config = resolveConfig({}, operator);

      // Default retention is 7, operator max is 3 — default falls back to
      // operator default (which itself falls back to library default 7),
      // then gets clamped to 3
      expect(config.retentionDays).toBe(3);
    });

    it('handles operator defaultRetentionDays exceeding maxRetentionDays', () => {
      // This is a misconfiguration, but resolveConfig should handle it gracefully
      const operator: OperatorConfig = {
        defaultRetentionDays: 90,
        maxRetentionDays: 30,
      };

      const config = resolveConfig({}, operator);

      // Default of 90 gets clamped to max of 30
      expect(config.retentionDays).toBe(30);
    });

    it('does not clamp when operator has no caps', () => {
      const user: UserConfig = {
        retentionDays: 365,
        batching: { maxRequests: 50_000, maxBytes: 200_000_000 },
        polling: { maxRetries: 100 },
      };

      const config = resolveConfig({}, {}, user);

      expect(config.retentionDays).toBe(365);
      expect(config.batching.maxRequests).toBe(50_000);
      expect(config.batching.maxBytes).toBe(200_000_000);
      expect(config.polling.maxRetries).toBe(100);
    });

    it('env config is accepted without error (reserved for future use)', () => {
      const env: EnvConfig = {
        masterKey: 'test-key',
        databaseUrl: 'postgres://localhost/norush',
        nodeEnv: 'test',
      };

      // Should not throw
      const config = resolveConfig(env);
      expect(config.retentionDays).toBe(7);
    });

    it('partially specified user batching merges with defaults', () => {
      const user: UserConfig = {
        batching: { maxRequests: 200 },
        // maxBytes and flushIntervalMs not specified
      };

      const config = resolveConfig({}, {}, user);

      expect(config.batching.maxRequests).toBe(200);
      expect(config.batching.maxBytes).toBe(50_000_000);
      expect(config.batching.flushIntervalMs).toBe(300_000);
    });

    it('partially specified operator batching merges with defaults', () => {
      const operator: OperatorConfig = {
        batching: { maxRequests: 500 },
      };

      const config = resolveConfig({}, operator);

      expect(config.batching.maxRequests).toBe(500);
      expect(config.batching.maxBytes).toBe(50_000_000);
      expect(config.batching.flushIntervalMs).toBe(300_000);
    });
  });
});
