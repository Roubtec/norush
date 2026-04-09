# Add Observability Adapters, Documentation, and Deploy Templates

## Why this task exists

Production operators need metrics pipelines (Prometheus, Datadog, OpenTelemetry) and new users need documentation and deployment guides to adopt norush.
This task delivers the final production-readiness items.

## Scope

**Included:**
- `PrometheusTelemetry` adapter implementing `TelemetryHook`
- `OpenTelemetryTelemetry` adapter implementing `TelemetryHook`
- Documentation site (or comprehensive README): architecture, API reference, configuration guide, deployment guide
- Deploy-to-Azure template (Bicep or ARM template)
- GitHub Actions / cron integration examples
- Example webhook consumer

**Out of scope:**
- Datadog-specific adapter (OpenTelemetry covers Datadog via OTLP export)
- Grafana dashboard templates (operational concern)

## Context and references

- PLAN.md Section 6.7 (Telemetry) — metric categories, hook interface, Prometheus/Datadog/OTel listed as Phase 4
- PLAN.md Section 7.2 (Azure Container Apps) — deploy-to-Azure template
- PLAN.md Section 8, Phase 4 — documentation site, integration examples

## Target files or areas

```
packages/core/src/
├── telemetry/
│   ├── prometheus.ts         # PrometheusTelemetry
│   └── opentelemetry.ts      # OpenTelemetryTelemetry
packages/core/test/
└── telemetry/
    ├── prometheus.test.ts
    └── opentelemetry.test.ts
docs/                          # Documentation
├── getting-started.md
├── configuration.md
├── api-reference.md
├── deployment.md
└── architecture.md
examples/
├── webhook-consumer/          # Example webhook handler
├── cron-batch/                # Example cron-triggered batch job
└── github-action/             # Example GitHub Actions workflow using norush
infra/
└── azure/
    └── main.bicep             # Azure Container Apps + PostgreSQL template
```

## Implementation notes

- **PrometheusTelemetry:** Use `prom-client` library. Register counters, histograms, and gauges matching PLAN.md Section 6.7 metric categories. Expose a `/metrics` endpoint in the web server.
- **OpenTelemetryTelemetry:** Use `@opentelemetry/api`. Create meters and instruments for each metric. Compatible with any OTLP-compatible backend.
- **Documentation:** Can be Markdown files in `docs/` (rendered by GitHub) or a simple static site. Cover:
  - Getting started: install, configure, first batch
  - Configuration: all three tiers, environment variables, operator config
  - API reference: all public methods and types
  - Deployment: Docker, Azure, self-hosted
  - Architecture: component overview referencing PLAN.md
- **Azure Bicep template:** Define Container Apps environment, web container, worker container, PostgreSQL Flexible Server, ACR. Parameterized for customization.
- **Examples:** Small, self-contained projects showing common integration patterns.

### Dependencies

- Requires task 1-02 (TelemetryHook interface).
- Requires task 4-04 (published package for examples to reference).
- Requires task 2-06 (Azure deployment knowledge for template).

## Acceptance criteria

- `PrometheusTelemetry` and `OpenTelemetryTelemetry` implement `TelemetryHook` correctly.
- `/metrics` endpoint exposes Prometheus-format metrics.
- Documentation covers getting started, configuration, API, deployment, and architecture.
- Azure Bicep template deploys a working norush instance.
- Examples are self-contained and runnable.
- `pnpm build` and `pnpm typecheck` pass.

## Validation

- Configure `PrometheusTelemetry`, run some batches, scrape `/metrics` → verify counters increment.
- Configure `OpenTelemetryTelemetry` with a console exporter → verify metrics appear.
- Follow the getting-started guide from scratch → verify a working setup.
- Deploy the Bicep template to a test Azure subscription → verify it works.
- Run each example → verify it completes successfully.

## Review plan

- Verify telemetry adapters cover all metric categories from PLAN.md Section 6.7.
- Verify documentation is accurate and references the current API.
- Check that Bicep template is parameterized (no hardcoded values).
- Confirm examples use the published `@norush/core` package, not workspace references.
