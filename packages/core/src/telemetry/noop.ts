import type { TelemetryHook } from "../interfaces/telemetry.js";

/**
 * No-op telemetry implementation.
 *
 * Default telemetry hook that silently discards all metrics and events.
 * Used when no telemetry backend is configured.
 */
export class NoopTelemetry implements TelemetryHook {
  counter(_name: string, _value: number, _tags?: Record<string, string>): void {
    // intentionally empty
  }

  histogram(
    _name: string,
    _value: number,
    _tags?: Record<string, string>,
  ): void {
    // intentionally empty
  }

  event(_name: string, _data?: Record<string, unknown>): void {
    // intentionally empty
  }
}
