# Deployment

norush can be deployed as Docker containers, on Azure Container Apps, or self-hosted on any platform that runs Node.js 24+.

## Docker

The project ships a multi-stage `Dockerfile` that produces a single image for both the web server and the background worker.

### Build and Run

```bash
# Build the image
docker build -t norush .

# Run the web server
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://user:pass@host:5432/norush \
  -e NORUSH_MASTER_KEY=your-secret-key \
  norush

# Run the worker
docker run \
  -e DATABASE_URL=postgres://user:pass@host:5432/norush \
  -e NORUSH_MASTER_KEY=your-secret-key \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  norush node packages/core/dist/worker.js
```

### Docker Compose

The included `docker-compose.yml` runs the full stack:

```bash
docker compose up --build
```

This starts:

- PostgreSQL 17 on port 5432
- Web server on port 3000
- Background worker

## Azure Container Apps

norush is designed for Azure Container Apps with PostgreSQL Flexible Server.
See [infra/README.md](../infra/README.md) for step-by-step Azure CLI setup.

### Infrastructure as Code (Bicep)

The `infra/azure/main.bicep` template provisions:

- Azure Container Apps environment
- Web container app (scale-to-zero)
- Worker container app (always-on, single replica)
- Azure Database for PostgreSQL Flexible Server
- Azure Container Registry

Deploy with:

```bash
az deployment group create \
  --resource-group norush-prod \
  --template-file infra/azure/main.bicep \
  --parameters \
    postgresAdminPassword='YOUR_PASSWORD' \
    norushMasterKey='YOUR_MASTER_KEY' \
    acrName='norushacr' \
    imageTag='latest'
```

### Cost Estimates

| Resource | SKU | Estimated Monthly Cost |
|----------|-----|----------------------|
| Container Apps (web, scale-to-zero) | Consumption | ~$5-15 |
| Container Apps (worker, always-on) | Consumption, 0.5 vCPU / 1 GiB | ~$30 |
| PostgreSQL Flexible Server | Burstable B1ms | ~$15 |
| Container Registry | Basic | ~$5 |
| **Total** | | **~$55-65/month** |

### CI/CD

The GitHub Actions workflow at `.github/workflows/deploy.yml` builds and deploys on merge to `main`.
Required GitHub secrets:

| Secret | Description |
|--------|-------------|
| `AZURE_CREDENTIALS` | Service principal JSON |
| `ACR_LOGIN_SERVER` | e.g. `norushacr.azurecr.io` |
| `ACR_USERNAME` | ACR admin username |
| `ACR_PASSWORD` | ACR admin password |
| `AZURE_RESOURCE_GROUP` | Resource group name |
| `AZURE_CONTAINER_APP_WEB` | Web container app name |
| `AZURE_CONTAINER_APP_WORKER` | Worker container app name |

## Self-Hosted

### Requirements

- Node.js >= 24
- PostgreSQL >= 15
- A process manager (systemd, PM2, etc.)

### Steps

#### 1. Clone the repository and install dependencies:

```bash
git clone https://github.com/norush-ai/norush.git
cd norush
pnpm install
pnpm build
```

#### 2. Set environment variables:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/norush
export NORUSH_MASTER_KEY=$(openssl rand -base64 32)
export ANTHROPIC_API_KEY=sk-ant-...
```

#### 3. Start the web server:

```bash
node packages/web/dist/index.js
```

#### 4. Start the worker (separate process):

```bash
node packages/core/dist/worker.js
```

### Systemd Example

```ini
# /etc/systemd/system/norush-web.service
[Unit]
Description=norush web server
After=postgresql.service

[Service]
Type=simple
User=norush
WorkingDirectory=/opt/norush
Environment=DATABASE_URL=postgres://norush:pass@localhost:5432/norush
Environment=NORUSH_MASTER_KEY=your-key
Environment=PORT=3000
ExecStart=/usr/bin/node packages/web/dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/norush-worker.service
[Unit]
Description=norush background worker
After=postgresql.service

[Service]
Type=simple
User=norush
WorkingDirectory=/opt/norush
Environment=DATABASE_URL=postgres://norush:pass@localhost:5432/norush
Environment=NORUSH_MASTER_KEY=your-key
Environment=ANTHROPIC_API_KEY=sk-ant-...
ExecStart=/usr/bin/node packages/core/dist/worker.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## Monitoring

### Prometheus

#### 1. Configure `PrometheusTelemetry` in your engine:

```typescript
import { PrometheusTelemetry } from "@norush/core";
import { Registry } from "prom-client";

const registry = new Registry();
const telemetry = new PrometheusTelemetry(registry);

const engine = createNorush({
  // ...
  telemetry,
});
```

#### 2. The web application exposes `GET /metrics` which returns Prometheus exposition format text.

#### 3. Add a scrape config to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: norush
    scrape_interval: 15s
    static_configs:
      - targets: ["norush-web:3000"]
    metrics_path: /metrics
```

### OpenTelemetry

#### 1. Install the OpenTelemetry SDK and an exporter:

```bash
npm install @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
```

#### 2. Configure the SDK before creating the engine:

```typescript
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { metrics } from "@opentelemetry/api";
import { OpenTelemetryTelemetry } from "@norush/core";

const exporter = new OTLPMetricExporter({
  url: "http://otel-collector:4318/v1/metrics",
});

const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter })],
});

metrics.setGlobalMeterProvider(provider);

const telemetry = new OpenTelemetryTelemetry("norush");
```

This works with any OTLP-compatible backend: Datadog, Grafana Cloud, New Relic, Honeycomb, etc.

## Health Checks

The web application exposes `GET /api/health` which returns:

- `200 OK` with `{"status": "ok", "database": "connected"}` when healthy.
- `503 Service Unavailable` when the database is unreachable.

Configure your load balancer or container orchestrator to probe this endpoint.

## Rollback

To roll back to a previous version on Azure:

```bash
# List available image tags
az acr repository show-tags --name norushacr --repository norush --orderby time_desc

# Deploy a previous tag
az containerapp update \
  --resource-group norush-prod \
  --name norush-web \
  --image norushacr.azurecr.io/norush:sha-PREVIOUS
```

## Migrations

Database migrations run automatically when the worker starts.
To run them manually, see [infra/README.md](../infra/README.md).
