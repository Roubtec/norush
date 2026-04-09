/**
 * Telemetry hook interface.
 *
 * All key engine paths instrument through this interface. Ship NoopTelemetry
 * (default) and ConsoleTelemetry (debugging). Prometheus / Datadog /
 * OpenTelemetry adapters can be added later without engine changes.
 */
export interface TelemetryHook {
  /** Increment a counter metric. */
  counter(name: string, value: number, tags?: Record<string, string>): void;

  /** Record a histogram (distribution) metric. */
  histogram(name: string, value: number, tags?: Record<string, string>): void;

  /** Emit a discrete event for logging / tracing. */
  event(name: string, data?: Record<string, unknown>): void;
}
