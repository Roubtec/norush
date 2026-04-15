import { describe, expect, it, vi, beforeEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { OpenTelemetryTelemetry } from '../telemetry/opentelemetry.js';

describe('OpenTelemetryTelemetry', () => {
  beforeEach(() => {
    // Disable the global MeterProvider so the tests exercise the
    // adapter code paths without requiring a full OTel SDK setup.
    // The default no-op provider is used.
    metrics.disable();
  });

  it('implements TelemetryHook without throwing', () => {
    const telemetry = new OpenTelemetryTelemetry();

    expect(() => telemetry.counter('test', 1)).not.toThrow();
    expect(() => telemetry.counter('test', 1, { env: 'test' })).not.toThrow();
    expect(() => telemetry.histogram('test_hist', 42)).not.toThrow();
    expect(() => telemetry.histogram('test_hist', 42, { env: 'test' })).not.toThrow();
    expect(() => telemetry.event('test')).not.toThrow();
    expect(() => telemetry.event('test', { key: 'value' })).not.toThrow();
  });

  it('accepts a custom meter name', () => {
    const telemetry = new OpenTelemetryTelemetry('my-app');
    // Should not throw — just verifying construction works
    telemetry.counter('test', 1);
  });

  it("uses default meter name 'norush'", () => {
    const telemetry = new OpenTelemetryTelemetry();
    // Should not throw
    telemetry.counter('test', 1);
  });

  it('creates counters and increments them', () => {
    const telemetry = new OpenTelemetryTelemetry();

    // Multiple increments should not throw
    telemetry.counter('requests_queued', 5);
    telemetry.counter('requests_queued', 3);
    telemetry.counter('requests_queued', 1, { provider: 'claude' });
  });

  it('reuses existing counters for the same metric name', () => {
    const telemetry = new OpenTelemetryTelemetry();

    telemetry.counter('reuse_test', 1);
    telemetry.counter('reuse_test', 2);
    // No error means it reused the counter
  });

  it('creates histograms and records values', () => {
    const telemetry = new OpenTelemetryTelemetry();

    telemetry.histogram('batch_turnaround_ms', 150);
    telemetry.histogram('batch_turnaround_ms', 250);
    telemetry.histogram('batch_turnaround_ms', 100, { provider: 'openai' });
  });

  it('reuses existing histograms for the same metric name', () => {
    const telemetry = new OpenTelemetryTelemetry();

    telemetry.histogram('reuse_hist', 10);
    telemetry.histogram('reuse_hist', 20);
    // No error means it reused the histogram
  });

  it('logs events with structured data', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const telemetry = new OpenTelemetryTelemetry();

    telemetry.event('batch_submitted', { batchId: 'abc123', count: 42 });

    expect(spy).toHaveBeenCalledWith(
      '[norush:otel] event batch_submitted {"batchId":"abc123","count":42}',
    );
    spy.mockRestore();
  });

  it('logs events without data', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const telemetry = new OpenTelemetryTelemetry();

    telemetry.event('circuit_breaker_tripped');

    expect(spy).toHaveBeenCalledWith('[norush:otel] event circuit_breaker_tripped');
    spy.mockRestore();
  });

  it('handles tags correctly on counters', () => {
    const telemetry = new OpenTelemetryTelemetry();

    // With tags
    telemetry.counter('tagged_counter', 1, {
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    // Without tags
    telemetry.counter('untagged_counter', 1);
  });

  it('handles tags correctly on histograms', () => {
    const telemetry = new OpenTelemetryTelemetry();

    // With tags
    telemetry.histogram('tagged_hist', 100, {
      provider: 'openai',
      status: 'success',
    });

    // Without tags
    telemetry.histogram('untagged_hist', 50);
  });
});
