import { Counter, Histogram, Registry } from "prom-client";
import type { TelemetryHook } from "../interfaces/telemetry.js";

/**
 * Prometheus telemetry adapter.
 *
 * Maps TelemetryHook calls to `prom-client` instruments. Each unique
 * metric name gets a dedicated Counter or Histogram, created lazily
 * on first use. Tags become Prometheus labels.
 *
 * **Important:** Prometheus requires all label names to be declared
 * when a metric is first created. The label names from the first call
 * to `counter()` or `histogram()` for a given metric name become the
 * permanent label set. Subsequent calls with different label names
 * will fail. Always use a consistent set of tag keys per metric name.
 * Passing an empty object `{}` or `undefined` for tags is safe when
 * the metric was created without labels.
 *
 * Expose the collected metrics by calling `registry.metrics()` from
 * your HTTP metrics endpoint (e.g. GET /metrics).
 */
export class PrometheusTelemetry implements TelemetryHook {
  readonly registry: Registry;

  private counters = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();

  /**
   * @param registry - Optional custom Registry. When omitted a new
   *   dedicated Registry is created (avoids polluting the global default).
   */
  constructor(registry?: Registry) {
    this.registry = registry ?? new Registry();
  }

  counter(name: string, value: number, tags?: Record<string, string>): void {
    let c = this.counters.get(name);
    if (!c) {
      const labelNames = tags ? Object.keys(tags).sort() : [];
      c = new Counter({
        name: sanitize(name),
        help: `norush counter: ${name}`,
        labelNames,
        registers: [this.registry],
      });
      this.counters.set(name, c);
    }
    if (tags && Object.keys(tags).length > 0) {
      c.inc(tags, value);
    } else {
      c.inc(value);
    }
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    let h = this.histograms.get(name);
    if (!h) {
      const labelNames = tags ? Object.keys(tags).sort() : [];
      h = new Histogram({
        name: sanitize(name),
        help: `norush histogram: ${name}`,
        labelNames,
        registers: [this.registry],
      });
      this.histograms.set(name, h);
    }
    if (tags && Object.keys(tags).length > 0) {
      h.observe(tags, value);
    } else {
      h.observe(value);
    }
  }

  event(_name: string, _data?: Record<string, unknown>): void {
    // Prometheus has no native concept of discrete events.
    // Events are intentionally dropped — use ConsoleTelemetry or
    // OpenTelemetryTelemetry to capture them.
  }
}

/**
 * Sanitize a metric name into a valid Prometheus identifier.
 * Prometheus metric names must match [a-zA-Z_:][a-zA-Z0-9_:]*.
 */
function sanitize(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  if (/^[0-9]/.test(s)) {
    s = "_" + s;
  }
  return s;
}
