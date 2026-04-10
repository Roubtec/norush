// ============================================================================
// norush — Azure Container Apps + PostgreSQL Bicep template
// ============================================================================
//
// Deploys the full norush stack:
//   - Azure Container Registry (ACR)
//   - Azure Database for PostgreSQL Flexible Server
//   - Azure Container Apps environment
//   - Web container app (SvelteKit, scale-to-zero)
//   - Worker container app (background loops, always-on single replica)
//
// Usage:
//   az deployment group create \
//     --resource-group norush-prod \
//     --template-file infra/azure/main.bicep \
//     --parameters \
//       postgresAdminPassword='YOUR_PASSWORD' \
//       norushMasterKey='YOUR_MASTER_KEY' \
//       acrName='norushacr' \
//       imageTag='latest'
//
// ============================================================================

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Name of the Azure Container Registry (must be globally unique, lowercase, no hyphens).')
param acrName string

@description('Docker image tag to deploy.')
param imageTag string = 'latest'

@description('PostgreSQL administrator username.')
param postgresAdminUser string = 'norush'

@secure()
@description('PostgreSQL administrator password.')
param postgresAdminPassword string

@description('PostgreSQL database name.')
param postgresDatabaseName string = 'norush'

@description('PostgreSQL server SKU name.')
param postgresSkuName string = 'Standard_B1ms'

@description('PostgreSQL server SKU tier.')
param postgresSkuTier string = 'Burstable'

@description('PostgreSQL storage size in GB.')
param postgresStorageSizeGB int = 32

@secure()
@description('norush master encryption key for API key vault.')
param norushMasterKey string

@description('WorkOS API key (optional, for authentication).')
@secure()
param workosApiKey string = ''

@description('WorkOS client ID (optional, for authentication).')
param workosClientId string = ''

@description('Public origin URL (e.g. https://norush.chat).')
param origin string = ''

@description('Web container CPU cores.')
param webCpu string = '0.5'

@description('Web container memory.')
param webMemory string = '1Gi'

@description('Web container max replicas.')
param webMaxReplicas int = 3

@description('Worker container CPU cores.')
param workerCpu string = '0.5'

@description('Worker container memory.')
param workerMemory string = '1Gi'

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

var postgresServerName = '${acrName}-db'
var containerEnvName = '${acrName}-env'
var webAppName = '${acrName}-web'
var workerAppName = '${acrName}-worker'
var databaseUrl = 'postgresql://${postgresAdminUser}:${postgresAdminPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/${postgresDatabaseName}?sslmode=require'
var acrLoginServer = acr.properties.loginServer
var imageName = '${acrLoginServer}/norush:${imageTag}'

// ---------------------------------------------------------------------------
// Azure Container Registry
// ---------------------------------------------------------------------------

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL Flexible Server
// ---------------------------------------------------------------------------

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: postgresServerName
  location: location
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    version: '17'
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: postgresStorageSizeGB
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Create the database
resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure services to connect
resource postgresFirewallRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: postgresServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Require SSL
resource postgresSslParam 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgresServer
  name: 'require_secure_transport'
  properties: {
    value: 'on'
    source: 'user-override'
  }
}

// ---------------------------------------------------------------------------
// Log Analytics workspace (required by Container Apps)
// ---------------------------------------------------------------------------

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${acrName}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// ---------------------------------------------------------------------------
// Container Apps Environment
// ---------------------------------------------------------------------------

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Web Container App
// ---------------------------------------------------------------------------

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
        {
          name: 'database-url'
          value: databaseUrl
        }
        {
          name: 'master-key'
          value: norushMasterKey
        }
        {
          name: 'workos-api-key'
          value: workosApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: imageName
          resources: {
            cpu: json(webCpu)
            memory: webMemory
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'NORUSH_MASTER_KEY', secretRef: 'master-key' }
            { name: 'WORKOS_API_KEY', secretRef: 'workos-api-key' }
            { name: 'WORKOS_CLIENT_ID', value: workosClientId }
            { name: 'ORIGIN', value: origin }
            { name: 'NODE_ENV', value: 'production' }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: webMaxReplicas
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    postgresDatabase
    postgresFirewallRule
  ]
}

// ---------------------------------------------------------------------------
// Worker Container App
// ---------------------------------------------------------------------------

resource workerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: workerAppName
  location: location
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      registries: [
        {
          server: acrLoginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
        {
          name: 'database-url'
          value: databaseUrl
        }
        {
          name: 'master-key'
          value: norushMasterKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: imageName
          command: [ 'node', 'packages/core/dist/worker.js' ]
          resources: {
            cpu: json(workerCpu)
            memory: workerMemory
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'NORUSH_MASTER_KEY', secretRef: 'master-key' }
            { name: 'NODE_ENV', value: 'production' }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    postgresDatabase
    postgresFirewallRule
  ]
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output webUrl string = 'https://${webApp.properties.configuration.ingress.fqdn}'
output acrLoginServer string = acrLoginServer
output postgresHost string = postgresServer.properties.fullyQualifiedDomainName
