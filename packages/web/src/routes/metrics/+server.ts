/**
 * GET /metrics
 *
 * Serves Prometheus-format metrics from the prom-client registry.
 *
 * The PrometheusTelemetry adapter (from @norush/core) registers
 * counters, histograms, and gauges into a prom-client Registry.
 * This route calls registry.metrics() and returns the text in
 * Prometheus exposition format.
 *
 * Configure your Prometheus scrape target to point at this endpoint.
 */

import { Registry } from "prom-client";
import type { RequestHandler } from "./$types";

/**
 * Shared prom-client registry used by the PrometheusTelemetry adapter.
 * Import this from server modules that need to register the telemetry
 * adapter with the same registry.
 */
export const registry = new Registry();

export const GET: RequestHandler = async () => {
  const body = await registry.metrics();

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": registry.contentType,
    },
  });
};
