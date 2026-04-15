import { describe, expect, it } from 'vitest';
import { Registry } from 'prom-client';
import { PrometheusTelemetry } from '../telemetry/prometheus.js';

describe('PrometheusTelemetry', () => {
  it('implements TelemetryHook without throwing', () => {
    const telemetry = new PrometheusTelemetry();

    // Counters / histograms without tags
    expect(() => telemetry.counter('test_counter', 1)).not.toThrow();
    expect(() => telemetry.histogram('test_hist', 42)).not.toThrow();

    // Counters / histograms with tags (separate metric names since
    // Prometheus requires consistent label sets per metric)
    expect(() => telemetry.counter('test_tagged', 1, { env: 'test' })).not.toThrow();
    expect(() => telemetry.histogram('test_hist_tagged', 42, { env: 'test' })).not.toThrow();

    // Events
    expect(() => telemetry.event('test')).not.toThrow();
    expect(() => telemetry.event('test', { key: 'value' })).not.toThrow();
  });

  it('creates a dedicated Registry when none is provided', () => {
    const telemetry = new PrometheusTelemetry();
    expect(telemetry.registry).toBeInstanceOf(Registry);
  });

  it('uses a custom Registry when provided', () => {
    const custom = new Registry();
    const telemetry = new PrometheusTelemetry(custom);
    expect(telemetry.registry).toBe(custom);
  });

  it('increments a counter and exposes it via the registry', async () => {
    const telemetry = new PrometheusTelemetry();

    telemetry.counter('requests_queued', 5);
    telemetry.counter('requests_queued', 3);

    const output = await telemetry.registry.metrics();
    expect(output).toContain('requests_queued');
    // Total should be 8
    expect(output).toContain('8');
  });

  it('records a histogram and exposes it via the registry', async () => {
    const telemetry = new PrometheusTelemetry();

    telemetry.histogram('batch_turnaround_ms', 150);
    telemetry.histogram('batch_turnaround_ms', 250);

    const output = await telemetry.registry.metrics();
    expect(output).toContain('batch_turnaround_ms');
    expect(output).toContain('_count 2');
  });

  it('includes label values in counter output', async () => {
    const telemetry = new PrometheusTelemetry();

    telemetry.counter('requests_queued', 1, { provider: 'claude' });
    telemetry.counter('requests_queued', 2, { provider: 'openai' });

    const output = await telemetry.registry.metrics();
    expect(output).toContain('provider="claude"');
    expect(output).toContain('provider="openai"');
  });

  it('includes label values in histogram output', async () => {
    const telemetry = new PrometheusTelemetry();

    telemetry.histogram('delivery_latency_ms', 50, { status: 'success' });

    const output = await telemetry.registry.metrics();
    expect(output).toContain('status="success"');
  });

  it('sanitizes metric names with invalid characters', async () => {
    const telemetry = new PrometheusTelemetry();

    // Hyphens and dots are not valid Prometheus metric characters
    telemetry.counter('my-metric.name', 1);

    const output = await telemetry.registry.metrics();
    expect(output).toContain('my_metric_name');
  });

  it('silently drops events (Prometheus has no event concept)', () => {
    const telemetry = new PrometheusTelemetry();

    // Should not throw
    telemetry.event('circuit_breaker_tripped', { provider: 'claude' });
  });

  it('reuses existing counters for the same metric name', async () => {
    const telemetry = new PrometheusTelemetry();

    telemetry.counter('reuse_test', 1);
    telemetry.counter('reuse_test', 1);

    const output = await telemetry.registry.metrics();
    // Should have exactly one metric definition
    const helpLines = output.split('\n').filter((l: string) => l.startsWith('# HELP reuse_test'));
    expect(helpLines).toHaveLength(1);
  });

  it('reuses existing histograms for the same metric name', async () => {
    const telemetry = new PrometheusTelemetry();

    telemetry.histogram('reuse_hist', 10);
    telemetry.histogram('reuse_hist', 20);

    const output = await telemetry.registry.metrics();
    const helpLines = output.split('\n').filter((l: string) => l.startsWith('# HELP reuse_hist'));
    expect(helpLines).toHaveLength(1);
  });
});
