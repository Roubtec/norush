import { metrics, type Counter, type Histogram, type Meter } from "@opentelemetry/api";
import type { TelemetryHook } from "../interfaces/telemetry.js";

/**
 * OpenTelemetry telemetry adapter.
 *
 * Maps TelemetryHook calls to OpenTelemetry Metrics API instruments.
 * Compatible with any OTLP-capable backend (Datadog, Grafana Cloud,
 * New Relic, etc.) through the OpenTelemetry SDK exporters.
 *
 * `@opentelemetry/api` is an optional peer dependency. Install it
 * alongside `@norush/core` when using this adapter:
 *
 *   npm install @opentelemetry/api
 *   import { OpenTelemetryTelemetry } from "@norush/core/opentelemetry";
 *
 * You must configure an OpenTelemetry SDK `MeterProvider` and register
 * it before creating this adapter, or instruments will be no-ops.
 *
 * Events are emitted via `console.log` with structured data since
 * the OpenTelemetry Metrics API does not have a native events concept.
 * Use the OpenTelemetry Logs/Events API separately if you need full
 * event pipeline integration.
 */
export class OpenTelemetryTelemetry implements TelemetryHook {
  private readonly meter: Meter;
  private counters = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();

  /**
   * @param meterName - Name used to create the OpenTelemetry Meter.
   *   Defaults to "norush".
   */
  constructor(meterName = "norush") {
    this.meter = metrics.getMeter(meterName);
  }

  counter(name: string, value: number, tags?: Record<string, string>): void {
    let c = this.counters.get(name);
    if (!c) {
      c = this.meter.createCounter(name, {
        description: `norush counter: ${name}`,
      });
      this.counters.set(name, c);
    }
    c.add(value, tags);
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    let h = this.histograms.get(name);
    if (!h) {
      h = this.meter.createHistogram(name, {
        description: `norush histogram: ${name}`,
      });
      this.histograms.set(name, h);
    }
    h.record(value, tags);
  }

  event(name: string, data?: Record<string, unknown>): void {
    // The OpenTelemetry Metrics API does not have a native events
    // concept. Log a structured JSON line so that any log collector
    // (e.g. OTLP log exporter) can capture it.
    const payload = data ? ` ${JSON.stringify(data)}` : "";
    console.log(`[norush:otel] event ${name}${payload}`);
  }
}
