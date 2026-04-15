# Azure Infrastructure Setup

This document describes how to set up the Azure resources required to run norush in production.
The approach is manual (Azure CLI / portal) for now; Bicep or Terraform can be added later.

## Prerequisites

- An Azure subscription.
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed and logged in (`az login`).
- The GitHub repository configured with the deploy workflow (`.github/workflows/deploy.yml`).

## Architecture

```txt
                    Internet
                       |
                       v
            +------------------------+
            |  Azure Container Apps  |
            |    Environment         |
            |                        |
            |  +-------+  +------+   |
            |  |  web  |  |worker|   |
            |  | :3000 |  | (bg) |   |
            |  +---+---+  +--+---+   |
            |      |          |      |
            +------+----------+------+
                   |          |
                   v          v
            +-------------------------+
            | Azure Database for      |
            | PostgreSQL Flex Server  |
            +-------------------------+

            +-------------------------+
            | Azure Container         |
            | Registry (ACR)          |
            +-------------------------+
```

Both containers run the same Docker image with different entrypoints:

- **web**: `node packages/web/build/index.js` (default CMD) -- SvelteKit app with API routes.
- **worker**: `node packages/core/dist/worker.js` -- background polling, batching, and delivery.

They communicate only through the shared PostgreSQL database.

## Step-by-step Setup

### 1. Set Variables

```bash
# Choose your values
RESOURCE_GROUP="norush-prod"
LOCATION="eastus"
ACR_NAME="norushacr"             # Must be globally unique, lowercase, no hyphens
PG_SERVER_NAME="norush-db"       # Must be globally unique
PG_ADMIN_USER="norush"
PG_ADMIN_PASS="$(openssl rand -base64 24)"  # Save this securely
PG_DB_NAME="norush"
CONTAINER_ENV="norush-env"
WEB_APP_NAME="norush-web"
WORKER_APP_NAME="norush-worker"

echo "PostgreSQL password: $PG_ADMIN_PASS"  # Save this!
```

### 2. Create Resource Group

```bash
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION"
```

### 3. Create Azure Container Registry

```bash
az acr create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ACR_NAME" \
  --sku Basic \
  --admin-enabled true

# Get login credentials (needed for GitHub Secrets)
az acr credential show --name "$ACR_NAME"
```

The `loginServer` will be something like `norushacr.azurecr.io`.

### 4. Create PostgreSQL Flexible Server

```bash
az postgres flexible-server create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PG_SERVER_NAME" \
  --location "$LOCATION" \
  --admin-user "$PG_ADMIN_USER" \
  --admin-password "$PG_ADMIN_PASS" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --version 17 \
  --storage-size 32 \
  --yes

# Create the database
az postgres flexible-server db create \
  --resource-group "$RESOURCE_GROUP" \
  --server-name "$PG_SERVER_NAME" \
  --database-name "$PG_DB_NAME"

# Allow Azure services to connect (required for Container Apps)
az postgres flexible-server firewall-rule create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PG_SERVER_NAME" \
  --rule-name "AllowAzureServices" \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0

# Require SSL
az postgres flexible-server parameter set \
  --resource-group "$RESOURCE_GROUP" \
  --server-name "$PG_SERVER_NAME" \
  --name require_secure_transport \
  --value on
```

Build the connection string:

```txt
DATABASE_URL=postgresql://<admin-user>:<password>@<server-name>.postgres.database.azure.com:5432/<db-name>?sslmode=require
```

Example:

```txt
DATABASE_URL=postgresql://norush:YOUR_PASSWORD@norush-db.postgres.database.azure.com:5432/norush?sslmode=require
```

### 5. Create Container Apps Environment

```bash
az containerapp env create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CONTAINER_ENV" \
  --location "$LOCATION"
```

### 6. Deploy the Web Container App

```bash
az containerapp create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME" \
  --environment "$CONTAINER_ENV" \
  --image "${ACR_NAME}.azurecr.io/norush:latest" \
  --registry-server "${ACR_NAME}.azurecr.io" \
  --registry-username "$(az acr credential show -n $ACR_NAME --query username -o tsv)" \
  --registry-password "$(az acr credential show -n $ACR_NAME --query passwords[0].value -o tsv)" \
  --target-port 3000 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 3 \
  --cpu 0.5 \
  --memory 1.0Gi \
  --env-vars \
    "DATABASE_URL=secretref:database-url" \
    "NORUSH_MASTER_KEY=secretref:master-key" \
    "WORKOS_API_KEY=secretref:workos-api-key" \
    "WORKOS_CLIENT_ID=secretref:workos-client-id" \
    "ORIGIN=https://norush.roubtec.com" \
    "NODE_ENV=production" \
  --secrets \
    "database-url=YOUR_DATABASE_URL" \
    "master-key=YOUR_MASTER_KEY" \
    "workos-api-key=YOUR_WORKOS_API_KEY" \
    "workos-client-id=YOUR_WORKOS_CLIENT_ID"
```

### 7. Deploy the Worker Container App

```bash
az containerapp create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WORKER_APP_NAME" \
  --environment "$CONTAINER_ENV" \
  --image "${ACR_NAME}.azurecr.io/norush:latest" \
  --registry-server "${ACR_NAME}.azurecr.io" \
  --registry-username "$(az acr credential show -n $ACR_NAME --query username -o tsv)" \
  --registry-password "$(az acr credential show -n $ACR_NAME --query passwords[0].value -o tsv)" \
  --ingress disabled \
  --min-replicas 1 \
  --max-replicas 1 \
  --cpu 0.5 \
  --memory 1.0Gi \
  --command "node" "packages/core/dist/worker.js" \
  --env-vars \
    "DATABASE_URL=secretref:database-url" \
    "NORUSH_MASTER_KEY=secretref:master-key" \
    "NODE_ENV=production" \
  --secrets \
    "database-url=YOUR_DATABASE_URL" \
    "master-key=YOUR_MASTER_KEY"
```

Key differences from the web container:

- `--ingress disabled` -- worker has no HTTP traffic.
- `--min-replicas 1` -- worker must always be running (polling/delivery loops).
- `--max-replicas 1` -- only one worker instance to avoid duplicate processing.
- `--command` overrides the Docker CMD to run the worker entrypoint.

### 8. Verify Deployment

```bash
# Get the web app URL
WEB_URL=$(az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME" \
  --query properties.configuration.ingress.fqdn \
  --output tsv)

echo "Web URL: https://$WEB_URL"

# Health check
curl "https://$WEB_URL/api/health"

# Check logs
az containerapp logs show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME" \
  --follow

az containerapp logs show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WORKER_APP_NAME" \
  --follow
```

## GitHub Repository Secrets

Configure these secrets in GitHub (Settings > Secrets and variables > Actions):

| Secret                       | Description                                            | Example                                                                           |
| ---------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `AZURE_CREDENTIALS`          | Service principal JSON from `az ad sp create-for-rbac` | `{"clientId":"...","clientSecret":"...","subscriptionId":"...","tenantId":"..."}` |
| `ACR_LOGIN_SERVER`           | ACR login server hostname                              | `norushacr.azurecr.io`                                                            |
| `ACR_USERNAME`               | ACR admin username                                     | `norushacr`                                                                       |
| `ACR_PASSWORD`               | ACR admin password                                     | (from `az acr credential show`)                                                   |
| `AZURE_RESOURCE_GROUP`       | Resource group name                                    | `norush-prod`                                                                     |
| `AZURE_CONTAINER_APP_WEB`    | Web Container App name                                 | `norush-web`                                                                      |
| `AZURE_CONTAINER_APP_WORKER` | Worker Container App name                              | `norush-worker`                                                                   |

Also configure as a repository variable (Settings > Secrets and variables > Actions > Variables):

| Variable     | Description                            | Example                      |
| ------------ | -------------------------------------- | ---------------------------- |
| `DEPLOY_URL` | Production base URL (for health check) | `https://norush.roubtec.com` |

### Creating the Service Principal

```bash
# Create a service principal with Contributor access to the resource group
az ad sp create-for-rbac \
  --name "norush-github-deploy" \
  --role Contributor \
  --scopes "/subscriptions/<SUBSCRIPTION_ID>/resourceGroups/norush-prod" \
  --json-auth

# Copy the entire JSON output as the AZURE_CREDENTIALS secret
```

## Custom Domain (norush.roubtec.com)

Once the web container is running:

```bash
# Add custom domain
az containerapp hostname add \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME" \
  --hostname "norush.roubtec.com"

# Azure will provide a TXT record for domain verification.
# Add the TXT record to your DNS, then bind the managed certificate:

az containerapp hostname bind \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME" \
  --hostname "norush.roubtec.com" \
  --environment "$CONTAINER_ENV" \
  --validation-method CNAME
```

DNS records needed:

| Type  | Name                       | Value                                          |
| ----- | -------------------------- | ---------------------------------------------- |
| CNAME | `norush.roubtec.com`       | `<web-app-fqdn>` (from `az containerapp show`) |
| TXT   | `asuid.norush.roubtec.com` | Domain verification token (from Azure)         |

Azure Container Apps provides a free managed TLS certificate once the domain is verified.

## Updating Secrets

To update secrets after initial deployment:

```bash
az containerapp secret set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME" \
  --secrets "database-url=NEW_VALUE"

# Restart to pick up new secrets
az containerapp revision restart \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME"
```

## Migrations

Migrations run automatically when the worker starts (the worker process runs pending migrations on startup before entering its polling loops).
No separate migration step is needed in the deployment pipeline.

To run migrations manually:

```bash
# Run a one-off job in the Container Apps environment
az containerapp job create \
  --resource-group "$RESOURCE_GROUP" \
  --name "norush-migrate" \
  --environment "$CONTAINER_ENV" \
  --image "${ACR_NAME}.azurecr.io/norush:latest" \
  --registry-server "${ACR_NAME}.azurecr.io" \
  --registry-username "$(az acr credential show -n $ACR_NAME --query username -o tsv)" \
  --registry-password "$(az acr credential show -n $ACR_NAME --query passwords[0].value -o tsv)" \
  --trigger-type Manual \
  --replica-timeout 300 \
  --cpu 0.25 \
  --memory 0.5Gi \
  --command "node" "-e" "import('postgres').then(async ({ default: postgres }) => { const sql = postgres(process.env.DATABASE_URL); try { const m = await import('./packages/core/dist/store/migrate.js'); await m.migrate(sql); } finally { await sql.end(); } })" \
  --env-vars "DATABASE_URL=secretref:database-url" \
  --secrets "database-url=YOUR_DATABASE_URL"

# Execute the migration job
az containerapp job start \
  --resource-group "$RESOURCE_GROUP" \
  --name "norush-migrate"
```

## Rollback

To roll back to a previous image version:

```bash
# List available image tags in ACR
az acr repository show-tags --name "$ACR_NAME" --repository norush --orderby time_desc

# Deploy a specific previous tag
az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP_NAME" \
  --image "${ACR_NAME}.azurecr.io/norush:sha-PREVIOUS"

az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WORKER_APP_NAME" \
  --image "${ACR_NAME}.azurecr.io/norush:sha-PREVIOUS"
```

## Cost Estimates

Using the Azure Container Apps consumption plan:

| Resource                            | SKU                           | Estimated Monthly Cost |
| ----------------------------------- | ----------------------------- | ---------------------- |
| Container Apps (web, scale-to-zero) | Consumption                   | ~$5-15 (pay per use)   |
| Container Apps (worker, always-on)  | Consumption, 0.5 vCPU / 1 GiB | ~$30                   |
| PostgreSQL Flexible Server          | Burstable B1ms                | ~$15                   |
| Container Registry                  | Basic                         | ~$5                    |
| **Total**                           |                               | **~$55-65/month**      |

These are rough estimates for low-traffic usage.
The web container scales to zero when idle, keeping costs minimal during development.
