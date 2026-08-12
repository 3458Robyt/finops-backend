import * as common from 'oci-common';
import * as core from 'oci-core';
import * as identity from 'oci-identity';
import * as monitoring from 'oci-monitoring';
import * as objectstorage from 'oci-objectstorage';
import * as usageapi from 'oci-usageapi';
import type {
  CloudIngestionJobContext,
  CloudIngestionConnection,
  CloudConnectionValidationResult,
  CloudCapabilityValidation,
  CloudIngestionProvider,
  CloudIngestionResult,
  FocusSourcePreviewResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import {
  getCredential,
  optionalString,
  readObjectArray,
  requireString,
} from './providerConfig.js';
import {
  collectOciTechnicalMetrics,
  readOciMetricDefinitions,
} from './oci/OciMonitoringCollector.js';
import {
  buildOciValidationJob,
  validateOciCall,
  validateOciCapabilities,
  withOciClient,
} from './oci/OciCapabilityValidator.js';
import type {
  OciComputeClient,
  OciIdentityClient,
  OciMonitoringClient,
  OciObjectStorageClient,
  OciUsageClient,
} from './oci/OciSdkContracts.js';
import { OciBillingCollector } from './oci/OciBillingCollector.js';
import { collectOciInventory } from './oci/OciInventoryCollector.js';
import { createOciResourceSearchClient } from './oci/OciResourceSearchCollector.js';
import { discoverOciInventoryCompartments } from './oci/OciCompartmentDiscovery.js';
import {
  buildOciFocusPreviewResult,
  discoverOciFocusObjects,
  readOciFocusLocations,
  readOciFocusObjects,
} from './oci/OciFocusSource.js';
import { withOciProviderRetry } from './oci/OciRetryPolicy.js';

export class OciSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'oci';
  private readonly billing: OciBillingCollector;

  constructor() {
    this.billing = new OciBillingCollector({
      createObjectStorageClient: (job) => this.createObjectStorageClient(job),
      createUsageClient: (job) => this.createUsageClient(job),
    });
  }

  public async validate(connection: CloudIngestionConnection): Promise<CloudConnectionValidationResult> {
    return validateOciCapabilities(connection, {
      providerCode: this.providerCode,
      createAuthProvider: (job) => this.createAuthProvider(job),
      createIdentityClient: (provider) => this.createIdentityClient(provider),
      createComputeClient: (job) => this.createComputeClient(job),
      createMonitoringClient: (job) => this.createMonitoringClient(job),
      validateStorage: (target, job, checkedAt) => this.validateStorageCapability(target, job, checkedAt),
    });
  }

  public async previewFocus(connection: CloudIngestionConnection, limit: number): Promise<FocusSourcePreviewResult> {
    const job = buildOciValidationJob(connection);
    const client = this.createObjectStorageClient(job);
    try {
      const configured = readOciFocusObjects(job);
      const discovery = await discoverOciFocusObjects(
        job,
        client,
        withOciProviderRetry,
        true,
      );
      const objects = [
        ...configured.map((object) => ({ object, source: 'configured' as const })),
        ...discovery.objects.map((object) => ({ object, source: 'discovered' as const })),
      ].slice(0, limit).map(({ object, source }) => ({
        name: object.objectName,
        location: `oci://${object.namespaceName}/${object.bucketName}/${object.objectName}`,
        source,
        ...(object.sizeBytes !== undefined ? { sizeBytes: object.sizeBytes } : {}),
        ...(object.lastModified !== undefined ? { lastModified: object.lastModified } : {}),
      }));
      return buildOciFocusPreviewResult(
        readOciFocusLocations(job).length,
        configured.length,
        discovery.objects.length,
        objects,
        discovery.errors,
      );
    } finally {
      client.close?.();
    }
  }

  public async collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (job.sourceType === 'BILLING_EXPORT') {
      return this.billing.collect(job);
    }

    if (job.sourceType === 'INVENTORY') {
      const inventory = await collectOciInventory(job, {
        createComputeClient: (context) => this.createComputeClient(context),
        createResourceSearchClient: (context) => createOciResourceSearchClient(this.createAuthProvider(context)),
        discoverCompartments: (context) => discoverOciInventoryCompartments(context, {
          createIdentityClient: (target) => this.createIdentityClient(this.createAuthProvider(target)),
          withRetry: withOciProviderRetry,
        }),
        withRetry: withOciProviderRetry,
      });
      return {
        apiCallCount: inventory.apiCallCount,
        objectsProcessed: inventory.resources.length,
        focusRows: [],
        resources: inventory.resources,
        metricSamples: [],
        warnings: inventory.warnings,
        coverage: {
          ...inventory.coverage,
          inventorySource: inventory.source,
          inventoryImplemented: true,
          resources: inventory.resources.length,
        },
      };
    }

    if (job.sourceType !== 'TECHNICAL_METRIC') {
      return this.emptyResult(0, [`Unsupported OCI ingestion source ${job.sourceType}`], {});
    }

    return collectOciTechnicalMetrics(job, {
      createClient: (context) => this.createMonitoringClient(context),
      withRetry: withOciProviderRetry,
    });
  }

  private createMonitoringClient(job: CloudIngestionJobContext): OciMonitoringClient {
    const provider = this.createAuthProvider(job);
    const client = new monitoring.MonitoringClient({
      authenticationDetailsProvider: provider,
    });

    return client as unknown as OciMonitoringClient;
  }

private createIdentityClient(
authenticationDetailsProvider: common.AuthenticationDetailsProvider,
): OciIdentityClient {
return new identity.IdentityClient({ authenticationDetailsProvider }) as unknown as OciIdentityClient;
}


private async validateStorageCapability(
connection: CloudIngestionConnection,
job: CloudIngestionJobContext,
checkedAt: Date,
): Promise<CloudCapabilityValidation> {
const location = readObjectArray(connection.metadata, 'ociFocusReportLocations')[0];
const object = readObjectArray(connection.metadata, 'ociFocusReportObjects')[0];
const namespaceName = optionalString(location?.['namespaceName'])
?? optionalString(location?.['namespace-name'])
?? optionalString(object?.['namespaceName'])
?? optionalString(object?.['namespace-name']);
const bucketName = optionalString(location?.['bucketName'])
?? optionalString(location?.['bucket-name'])
?? optionalString(object?.['bucketName'])
?? optionalString(object?.['bucket-name']);
const prefix = optionalString(location?.['prefix'])
?? optionalString(object?.['objectName'])
?? optionalString(object?.['object-name'])
?? '';
if (namespaceName === undefined || bucketName === undefined) {
return {
capability: 'STORAGE',
status: 'NOT_CONFIGURED',
message: 'Configura namespace y bucket FOCUS para validar Object Storage.',
checkedAt,
};
}

return validateOciCall('STORAGE', checkedAt, () => withOciClient(
this.createObjectStorageClient(job),
async (client) => {
await client.listObjects({
namespaceName,
bucketName,
prefix,
limit: 1,
});
return {
message: 'Lectura del almacenamiento FOCUS en OCI Object Storage disponible.',
metadata: { namespaceName, bucketName },
};
},
));
}

private createUsageClient(job: CloudIngestionJobContext): OciUsageClient {
const provider = this.createAuthProvider(job);
return new usageapi.UsageapiClient({
authenticationDetailsProvider: provider,
}) as unknown as OciUsageClient;
}

private createObjectStorageClient(job: CloudIngestionJobContext): OciObjectStorageClient {
const provider = this.createAuthProvider(job);
const client = new objectstorage.ObjectStorageClient({
authenticationDetailsProvider: provider,
});

return client as unknown as OciObjectStorageClient;
}

private createComputeClient(job: CloudIngestionJobContext): OciComputeClient {
const provider = this.createAuthProvider(job);
const client = new core.ComputeClient({
authenticationDetailsProvider: provider,
});

return client as unknown as OciComputeClient;
}

  private createAuthProvider(job: CloudIngestionJobContext): common.AuthenticationDetailsProvider {
const credential = getCredential(job.connection.credentials, [
'INVENTORY_READ',
'METRICS_READ',
'BILLING_EXPORT_READ',
'STORAGE_READ',
'OPERATIONAL',
]);
    if (credential === undefined) {
      throw new Error('OCI METRICS_READ, BILLING_EXPORT_READ, STORAGE_READ or OPERATIONAL credential is required');
    }

    const regionId = optionalString(credential.payload['region']) ?? job.connection.defaultRegion ?? 'sa-bogota-1';
    const region = common.Region.fromRegionId(regionId);
    return new common.SimpleAuthenticationDetailsProvider(
      requireString(credential.payload['tenancyId'], 'OCI tenancyId'),
      requireString(credential.payload['userId'], 'OCI userId'),
      requireString(credential.payload['fingerprint'], 'OCI fingerprint'),
      requireString(credential.payload['privateKey'], 'OCI privateKey'),
      optionalString(credential.payload['passphrase']) ?? null,
      region,
    );
  }

  private emptyResult(
    apiCallCount: number,
    warnings: readonly string[],
    coverage: Readonly<Record<string, unknown>>,
  ): CloudIngestionResult {
    return {
      apiCallCount,
      objectsProcessed: 0,
      focusRows: [],
      resources: [],
      metricSamples: [],
      warnings,
      coverage,
    };
  }

}
