# Deploy to Azure Container Apps with CI/CD

## Why this task exists

norush.chat needs to be publicly accessible.
This task sets up the Azure infrastructure and GitHub Actions pipeline to build, push, and deploy the Docker image automatically.

## Scope

**Included:**
- Azure Container Apps environment with web + worker containers
- Azure Database for PostgreSQL Flexible Server
- Azure Container Registry (ACR) for Docker images
- GitHub Actions workflow: build + push image on merge to main
- GitHub Actions workflow: deploy to Azure Container Apps
- Environment variable / secret configuration in Azure
- Custom domain setup (norush.chat) if DNS is available

**Out of scope:**
- Azure Key Vault integration for master key (use Container Apps secrets for now)
- Monitoring / alerting (Phase 4)
- Scale-to-zero tuning (operational optimization)
- CDN or edge caching

## Context and references

- PLAN.md Section 7.2 (Azure Container Apps) — deployment model, database, why Container Apps
- PLAN.md Section 7.7 (CI/CD: GitHub Actions) — pipeline stages
- PLAN.md Section 7.3 (Docker) — single image, two entrypoints

## Target files or areas

```
.github/workflows/
├── ci.yml                    # Already exists (lint + type-check + test) — may need update
└── deploy.yml                # New: build + push + deploy on merge to main
infra/                        # Optional: IaC scripts or documentation
└── README.md                 # Azure setup instructions (manual steps or Bicep/Terraform)
```

## Implementation notes

- **Azure Container Apps** setup:
  - One Container Apps environment.
  - Two containers: `web` (default entrypoint) and `worker` (command override).
  - Both share: `DATABASE_URL`, `NORUSH_MASTER_KEY`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`.
  - Web container: ingress enabled, port 3000, external traffic.
  - Worker container: no ingress (internal only).

- **Azure Database for PostgreSQL Flexible Server:**
  - PostgreSQL 17.
  - Same `DATABASE_URL` connection string format as local dev.
  - Enable SSL for production connections.

- **GitHub Actions deploy workflow:**
  - Trigger: push to `main`.
  - Steps: checkout → setup Node + pnpm → build Docker image → push to ACR → deploy to Container Apps.
  - Use Azure's official GitHub Actions (`azure/login`, `azure/container-apps-deploy`).
  - Store Azure credentials and ACR details as GitHub repository secrets.

- **Migrations:** Run as part of deployment (e.g., a job that runs `node -e "import('./packages/core/dist/store/migrate.js').then(m => m.migrate())"` before the new version starts serving traffic). Or run from the worker on startup.

- **IaC is optional at this stage** — manual Azure portal setup documented in `infra/README.md` is acceptable. Bicep or Terraform can be added later.

### Dependencies

- Requires task 2-05 (Docker image builds and runs correctly).
- Requires task 1-01 (CI workflow exists to extend).
- Requires Azure account and GitHub repository configured.

## Acceptance criteria

- Docker image is pushed to ACR on merge to main.
- Azure Container Apps runs both web and worker containers.
- Web container is publicly accessible via HTTPS.
- Worker container runs polling/delivery loops.
- Database is accessible from both containers via `DATABASE_URL`.
- Migrations run successfully on deployment.
- `GET /api/health` returns 200 on the deployed URL.
- End-to-end: log in → add key → submit message → result arrives.

## Validation

- Push to main → verify GitHub Actions workflow succeeds.
- Visit the deployed URL → verify the app loads and health check passes.
- Log in and submit a test message → verify the full lifecycle works in production.
- Check worker logs in Azure → verify polling is running.

## Review plan

- Verify secrets are not hardcoded in workflow files or Docker image.
- Verify database SSL is enabled for production.
- Verify migration runs before traffic is served.
- Check that Container Apps scaling configuration is reasonable (min 1 for worker, min 0-1 for web).
- Confirm rollback path: previous image version can be deployed manually.
