/**
 * Shared Prometheus registry for the web application.
 *
 * Import this from server routes or hooks to register telemetry
 * adapters against the same registry that powers GET /metrics.
 */

import { Registry } from "prom-client";

/**
 * Shared prom-client registry.
 * Pass this to PrometheusTelemetry when initializing the engine
 * so that all metrics are exposed at the /metrics endpoint.
 */
export const registry = new Registry();
