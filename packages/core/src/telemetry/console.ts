import type { TelemetryHook } from "../interfaces/telemetry.js";

/**
 * Console telemetry implementation.
 *
 * Logs all metrics and events to stdout with a `[norush]` prefix.
 * Useful for local development and debugging.
 */
export class ConsoleTelemetry implements TelemetryHook {
  counter(name: string, value: number, tags?: Record<string, string>): void {
    console.log(
      `[norush] counter ${name}=${value}${formatTags(tags)}`,
    );
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    console.log(
      `[norush] histogram ${name}=${value}${formatTags(tags)}`,
    );
  }

  event(name: string, data?: Record<string, unknown>): void {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    console.log(`[norush] event ${name}${suffix}`);
  }
}

function formatTags(tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return "";
  const pairs = Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return ` {${pairs}}`;
}
