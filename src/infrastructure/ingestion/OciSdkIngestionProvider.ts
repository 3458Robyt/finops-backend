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
import { discoverOciRegions } from './oci/OciRegionDiscovery.js';
import { discoverOciMetricDefinitions, type OciMetricDiscoveryResult } from './oci/OciMetricDiscovery.js';
import {
  buildOciFocusPreviewResult,
  discoverOciFocusObjects,
  readOciFocusLocations,
  readOciFocusObjects,
} from './oci/OciFocusSource.js';
import { withOciProviderRetry } from './oci/OciRetryPolicy.js';
import { IngestionRateCoordinator } from '../../application/services/IngestionRateCoordinator.js';

export class OciSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'oci';
  private readonly billing: OciBillingCollector;

  constructor(private readonly rateCoordinator = new IngestionRateCoordinator()) {
    this.billing = new OciBillingCollector({
      createObjectStorageClient: (job) => this.createObjectStorageClient(job),
      createUsageClient: (job) => this.createUsageClient(job),
      withRateLimit: (job, api, operation) => this.rateCoordinator.run(
        `oci:${job.connection.rootExternalId}:${this.regionKey(job)}:${api}`,
        api === 'usage'
          ? { requestsPerSecond: 2, maxConcurrent: 1 }
          : { requestsPerSecond: 5, maxConcurrent: 2 },
        operation,
      ),
    });
  }

  public async validate(connection: CloudIngestionConnection): Promise<CloudConnectionValidationResult> {
    return validateOciCapabilities(connection, {
      providerCode: this.providerCode,
      createAuthProvider: (job) => this.createAuthProvider(job),
      createIdentityClient: (provider, signal) => this.createIdentityClient(provider, signal),
      createComputeClient: (job, signal) => this.createComputeClient(job, signal),
      createMonitoringClient: (job, signal) => this.createMonitoringClient(job, signal),
      validateStorage: (target, job, checkedAt, signal) => this.validateStorageCapability(target, job, checkedAt, signal),
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
        (operation) => this.rateCoordinator.run(
          `oci:${connection.rootExternalId}:objectstorage`,
          { requestsPerSecond: 5, maxConcurrent: 2 },
          operation,
        ),
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
    return this.rateCoordinator.run(
      `oci:${job.connection.rootExternalId}:${this.regionKey(job)}:job`,
      { requestsPerSecond: 100, maxConcurrent: 2 },
      () => this.collectInternal(job),
    );
  }

  /** Read-only discovery used by onboarding; streams remain disabled until confirmation. */
  public async discoverMetricDefinitions(connection: CloudIngestionConnection): Promise<OciMetricDiscoveryResult> {
    return discoverOciMetricDefinitions(connection, {
      createClient: (context) => this.createMonitoringClient(context),
      discoverRegions: async (context) => {
        const result = await discoverOciRegions(context, {
          createIdentityClient: (target) => this.createIdentityClient(this.createAuthProvider(target)),
          withRetry: withOciProviderRetry,
        });
        return { regions: result.regionIds, apiCallCount: result.apiCallCount, warnings: result.warnings };
      },
      discoverCompartments: (context) => discoverOciInventoryCompartments(context, {
        createIdentityClient: (target) => this.createIdentityClient(this.createAuthProvider(target)),
        withRetry: withOciProviderRetry,
      }),
      withRetry: withOciProviderRetry,
      withRateLimit: (operation) => this.rateCoordinator.run(
        this.monitoringRateKey(connection),
        { requestsPerSecond: 8, maxConcurrent: 2 },
        operation,
      ),
    });
  }

  private async collectInternal(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
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
        discoverRegions: (context) => discoverOciRegions(context, {
          createIdentityClient: (target) => this.createIdentityClient(this.createAuthProvider(target)),
          withRetry: withOciProviderRetry,
        }),
        withRetry: withOciProviderRetry,
        withRateLimit: (context, api, operation) => this.rateCoordinator.run(
          `oci:${context.connection.rootExternalId}:${this.regionKey(context)}:${api}`,
          api === 'resourceSearch'
            ? { requestsPerSecond: 3, maxConcurrent: 2 }
            : { requestsPerSecond: 5, maxConcurrent: 2 },
          operation,
        ),
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
      withRateLimit: (context, operation) => this.rateCoordinator.run(
        this.monitoringRateKey(context.connection),
        { requestsPerSecond: 8, maxConcurrent: 4 },
        operation,
      ),
    });
  }

  private createMonitoringClient(job: CloudIngestionJobContext, signal?: AbortSignal): OciMonitoringClient {
    const provider = this.createAuthProvider(job);
    const client = new monitoring.MonitoringClient({
      authenticationDetailsProvider: provider,
      ...(signal === undefined ? {} : { httpOptions: { signal } }),
    });

    return client as unknown as OciMonitoringClient;
  }

private createIdentityClient(
authenticationDetailsProvider: common.AuthenticationDetailsProvider,
signal?: AbortSignal,
): OciIdentityClient {
return new identity.IdentityClient({
  authenticationDetailsProvider,
  ...(signal === undefined ? {} : { httpOptions: { signal } }),
}) as unknown as OciIdentityClient;
}


private async validateStorageCapability(
connection: CloudIngestionConnection,
job: CloudIngestionJobContext,
checkedAt: Date,
signal?: AbortSignal,
): Promise<CloudCapabilityValidation> {
const location = readObjectArray(connection.metadata, 'ociFocusReportLocations')[0];
const object = readObjectArray(connection.metadata, 'ociFocusReportObjects')[0];
const explicitNamespaceName = optionalString(location?.['namespaceName'])
?? optionalString(location?.['namespace-name'])
?? optionalString(object?.['namespaceName'])
?? optionalString(object?.['namespace-name']);
const explicitBucketName = optionalString(location?.['bucketName'])
?? optionalString(location?.['bucket-name'])
?? optionalString(object?.['bucketName'])
?? optionalString(object?.['bucket-name']);
const explicitPrefix = optionalString(location?.['prefix'])
?? optionalString(object?.['objectName'])
?? optionalString(object?.['object-name'])
?? undefined;
const autoDetected = connection.providerCode === 'oci'
  && explicitNamespaceName === undefined
  && explicitBucketName === undefined;
const namespaceName = explicitNamespaceName ?? (autoDetected ? 'bling' : undefined);
const bucketName = explicitBucketName ?? (autoDetected ? connection.rootExternalId : undefined);
const prefix = explicitPrefix ?? (autoDetected ? 'FOCUS Reports' : '');
if (namespaceName === undefined || bucketName === undefined) {
return {
capability: 'STORAGE',
status: 'NOT_CONFIGURED',
message: 'Configura namespace y bucket FOCUS para validar Object Storage.',
checkedAt,
};
}

return validateOciCall('STORAGE', checkedAt, () => withOciClient(
this.createObjectStorageClient(job, signal),
async (client) => {
await client.listObjects({
namespaceName,
bucketName,
prefix,
limit: 1,
});
return {
message: 'Lectura del almacenamiento FOCUS en OCI Object Storage disponible.',
 metadata: { namespaceName, bucketName, prefix, autoDetected },
};
},
));
}

private createUsageClient(job: CloudIngestionJobContext): OciUsageClient {
const provider = this.createAuthProvider(job);
  return new usageapi.UsageapiClient({
    authenticationDetailsProvider: provider,
  }, {
    circuitBreaker: new common.CircuitBreaker({ disableClientCircuitBreaker: true }),
  }) as unknown as OciUsageClient;
}

private createObjectStorageClient(job: CloudIngestionJobContext, signal?: AbortSignal): OciObjectStorageClient {
const provider = this.createAuthProvider(job);
const client = new objectstorage.ObjectStorageClient({
  authenticationDetailsProvider: provider,
  ...(signal === undefined ? {} : { httpOptions: { signal } }),
});

return client as unknown as OciObjectStorageClient;
}

private createComputeClient(job: CloudIngestionJobContext, signal?: AbortSignal): OciComputeClient {
const provider = this.createAuthProvider(job);
const client = new core.ComputeClient({
  authenticationDetailsProvider: provider,
  ...(signal === undefined ? {} : { httpOptions: { signal } }),
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

    const requestRegion = optionalString(job.requestContext?.['regionId']);
    const regionId = requestRegion ?? optionalString(credential.payload['region']) ?? job.connection.defaultRegion ?? 'sa-bogota-1';
    const region = common.Region.fromRegionId(regionId);
    return new common.SimpleAuthenticationDetailsProvider(
      requireString(credential.payload['tenancyId'], 'OCI tenancyId'),
      requireString(credential.payload['userId'], 'OCI userId'),
      requireString(credential.payload['fingerprint'], 'OCI fingerprint'),
      requireString(credential.payload['privateKey'], 'OCI privateKey'),
      readOciPassphrase(credential.payload['passphrase']),
      region,
    );
  }

  private monitoringRateKey(connection: Pick<CloudIngestionConnection, 'rootExternalId'>): string {
    // OCI Monitoring quotas are account-scoped. Region-specific buckets could
    // multiply the effective rate when a tenancy has several subscribed regions.
    return `oci:${connection.rootExternalId}:monitoring`;
  }

  private regionKey(job: CloudIngestionJobContext): string {
    return optionalString(job.requestContext?.['regionId'])
      ?? job.connection.defaultRegion
      ?? 'default';
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

function readOciPassphrase(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
