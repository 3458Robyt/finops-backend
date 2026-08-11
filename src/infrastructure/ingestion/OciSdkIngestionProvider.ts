import * as common from 'oci-common';
import * as core from 'oci-core';
import * as identity from 'oci-identity';
import * as monitoring from 'oci-monitoring';
import * as objectstorage from 'oci-objectstorage';
import * as usageapi from 'oci-usageapi';
import { createHash } from 'node:crypto';
import type {
  CloudIngestionJobContext,
  CloudIngestionConnection,
  CloudConnectionValidationResult,
  CloudCapabilityValidation,
  CloudIngestionProvider,
  CloudIngestionResult,
  FocusSourcePreviewResult,
  NormalizedCloudResource,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { parseFocusCsvStream, toAsyncByteChunks } from './focusCsvIngestion.js';
import {
  getCredential,
  optionalString,
  readBoundedPositiveInteger,
  readObjectArray,
  readStringArray,
  requireString,
} from './providerConfig.js';
import { resolveBillingSource } from './billingSourceMode.js';
import {
  collectOciTechnicalMetrics,
  readOciMetricDefinitions,
} from './oci/OciMonitoringCollector.js';
import {
  buildOciValidationJob,
  safeOciProviderError,
  validateOciCall,
  validateOciCapabilities,
  withOciClient,
} from './oci/OciCapabilityValidator.js';
import type {
  OciComputeClient,
  OciFocusReportLocation,
  OciFocusReportObject,
  OciIdentityClient,
  OciMonitoringClient,
  OciObjectStorageClient,
  OciUsageClient,
} from './oci/OciSdkContracts.js';

export class OciSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'oci';

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
      const configured = this.readFocusObjects(job);
      const discovery = await this.discoverFocusObjects(job, client, true);
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
        this.readFocusLocations(job).length,
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
      return this.collectBillingExport(job);
    }

if (job.sourceType === 'INVENTORY') {
const inventory = await this.collectInventoryResources(job);
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
      withRetry: (operation) => this.withProviderRetry(operation),
    });
  }

  private async collectBillingExport(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (resolveBillingSource(job) === 'PROVIDER_API') {
      return this.collectProviderApiCosts(job);
    }
    const client = this.createObjectStorageClient(job);
    let discovery: Awaited<ReturnType<OciSdkIngestionProvider['discoverFocusObjects']>>;
    try {
      discovery = await this.discoverFocusObjects(job, client);
    } catch (error) {
      client.close?.();
      throw error;
    }
    const objects = [...this.readFocusObjects(job), ...discovery.objects];
    if (objects.length === 0) {
      client.close?.();
      return this.emptyResult(0, [
        'No OCI FOCUS report objects configured or discovered. Configure ociFocusReportObjects or ociFocusReportLocations.',
      ], {
        costSource: 'OCI Cost Reports FOCUS',
        expectedRefreshHours: 6,
        objectsConfigured: 0,
        prefixesConfigured: this.readFocusLocations(job).length,
      });
    }

    let apiCallCount = discovery.apiCallCount;
    apiCallCount += objects.length;

    return {
      apiCallCount,
      objectsProcessed: objects.length,
      focusRows: [],
      focusBatches: this.streamFocusObjects(job, client, objects),
      resources: [],
      metricSamples: [],
      warnings: [],
      coverage: {
        costSource: 'OCI Cost Reports FOCUS',
        expectedRefreshHours: 6,
        objectsConfigured: objects.length,
        objectsDiscovered: discovery.objects.length,
        prefixesConfigured: this.readFocusLocations(job).length,
        rowsParsed: 'streamed',
      },
    };
  }

  private async collectProviderApiCosts(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    const provider = this.createAuthProvider(job);
    const client = new usageapi.UsageapiClient({ authenticationDetailsProvider: provider }) as unknown as OciUsageClient;
    try {
    const response = await this.withProviderRetry(() => client.requestSummarizedUsages({
      requestSummarizedUsagesDetails: {
        tenantId: job.connection.rootExternalId,
        timeUsageStarted: job.targetStart,
        timeUsageEnded: job.targetEnd,
        granularity: usageapi.models.RequestSummarizedUsagesDetails.Granularity.Daily,
        queryType: usageapi.models.RequestSummarizedUsagesDetails.QueryType.Cost,
        groupBy: ['service'],
      },
    }));
    const rows: NormalizedProviderCostLineItem[] = [];
    for (const item of response.usageAggregation?.items ?? []) {
      const amount = item.computedAmount;
      if (amount === undefined || !Number.isFinite(amount)) continue;
      const serviceName = item.service ?? 'Uncategorized';
      const rawRow = { ...item, targetStart: job.targetStart.toISOString(), targetEnd: job.targetEnd.toISOString() };
      rows.push({
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        provider: 'OCI',
        chargePeriodStart: job.targetStart,
        chargePeriodEnd: job.targetEnd,
        billingAccountId: job.connection.rootExternalId,
        serviceName,
        resourceId: item.resourceId ?? '',
        ...(item.region === undefined ? {} : { regionId: item.region }),
        billedCost: amount,
        billingCurrency: item.currency ?? 'USD',
        ...(item.computedQuantity === undefined ? {} : { consumedQuantity: item.computedQuantity }),
        sourceMetric: 'OCI_COMPUTED_AMOUNT',
        rawRow,
        lineItemHash: createHash('sha256').update(JSON.stringify(rawRow)).digest('hex'),
      });
    }
    return { apiCallCount: 1, objectsProcessed: 0, focusRows: [], providerCostRows: rows, resources: [], metricSamples: [], warnings: rows.length === 0 ? ['OCI Usage API returned no costs for the requested range.'] : [], coverage: { billingSource: 'PROVIDER_API', costSource: 'OCI Usage API', rows: rows.length } };
    } finally {
      client.close?.();
    }
  }

  private async *streamFocusObjects(
    job: CloudIngestionJobContext,
    client: OciObjectStorageClient,
    objects: readonly OciFocusReportObject[],
  ): AsyncGenerator<readonly NormalizedFocusCostLineItem[]> {
    const batch: NormalizedFocusCostLineItem[] = [];
    try {
    for (const object of objects) {
      const response = await this.withProviderRetry(() => client.getObject({
        namespaceName: object.namespaceName,
        bucketName: object.bucketName,
        objectName: object.objectName,
      }));
      for await (const line of parseFocusCsvStream(
        toAsyncByteChunks(response.getObjectBody ?? response.value),
        {
          tenantId: job.tenantId,
          cloudConnectionId: job.cloudConnectionId,
          provider: 'OCI',
          focusVersion: object.focusVersion,
        },
        object.objectName,
      )) {
        batch.push(line);
        if (batch.length >= 1000) {
          yield batch.splice(0, batch.length);
        }
      }
    }
    if (batch.length > 0) {
      yield batch;
    }
    } finally {
      client.close?.();
    }
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

private async collectInventoryResources(job: CloudIngestionJobContext): Promise<{
readonly apiCallCount: number;
readonly resources: readonly NormalizedCloudResource[];
readonly warnings: readonly string[];
readonly source: string;
readonly coverage: Readonly<Record<string, unknown>>;
}> {
const explicit = readObjectArray(job.connection.metadata, 'ociInventoryResources').map((item) => {
      const regionId = optionalString(item['regionId']) ?? optionalString(item['region']) ?? job.connection.defaultRegion;
      return {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        provider: 'OCI' as const,
        externalResourceId: requireString(item['externalResourceId'], 'ociInventoryResources.externalResourceId'),
        name: optionalString(item['name'])
          ?? optionalString(item['displayName'])
          ?? requireString(item['externalResourceId'], 'ociInventoryResources.externalResourceId'),
        resourceType: optionalString(item['resourceType']) ?? 'COMPUTE_INSTANCE',
        serviceName: optionalString(item['serviceName']) ?? 'Oracle Compute',
        ...(regionId !== undefined ? { regionId } : {}),
        status: this.normalizeResourceStatus(optionalString(item['status'])),
        rawResource: {
          source: 'OCI_INVENTORY_METADATA',
          ...item,
        },
      };
    });

    const inferred = readOciMetricDefinitions(job).map((definition) => ({
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      provider: 'OCI' as const,
      externalResourceId: definition.resourceId,
      name: definition.resourceId,
      resourceType: 'COMPUTE_INSTANCE',
      serviceName: 'Oracle Compute',
      ...(job.connection.defaultRegion !== undefined ? { regionId: job.connection.defaultRegion } : {}),
      status: 'UNKNOWN' as const,
      rawResource: {
        source: 'OCI_METRIC_DEFINITION',
        namespace: definition.namespace,
        compartmentId: definition.compartmentId,
        metricName: definition.metricName,
      },
}));

let sdkResources: readonly NormalizedCloudResource[] = [];
let apiCallCount = 0;
const warnings: string[] = [];
let coverage: Readonly<Record<string, unknown>> = {
inventoryCompartmentDiscovery: 'NOT_ATTEMPTED',
};

try {
const inventory = await this.collectComputeInventoryResources(job);
sdkResources = inventory.resources;
apiCallCount = inventory.apiCallCount;
coverage = inventory.coverage;
} catch (error) {
warnings.push(`OCI inventory SDK skipped: ${error instanceof Error ? error.message : String(error)}`);
coverage = {
inventoryCompartmentDiscovery: 'FAILED',
};
}

const resources = this.mergeInventoryResources([...inferred, ...explicit, ...sdkResources]);

if (resources.length === 0) {
warnings.push('No OCI inventory resources found from Compute SDK, metadata or metric definitions.');
}

return {
apiCallCount,
resources,
warnings,
source: sdkResources.length > 0 ? 'oci_compute_sdk_with_metadata_fallback' : 'metadata_and_metric_definitions',
coverage: {
...coverage,
configuredResourceCount: explicit.length,
metricDefinitionResourceCount: inferred.length,
sdkResourceCount: sdkResources.length,
mergedResourceCount: resources.length,
},
};
}

private async collectComputeInventoryResources(
job: CloudIngestionJobContext,
): Promise<{
readonly apiCallCount: number;
readonly resources: readonly NormalizedCloudResource[];
readonly coverage: Readonly<Record<string, unknown>>;
}> {
const client = this.createComputeClient(job);
const compartmentDiscovery = await this.listInventoryCompartmentIds(job);
const compartmentIds = compartmentDiscovery.compartmentIds;
const resources: NormalizedCloudResource[] = [];
let apiCallCount = compartmentDiscovery.apiCallCount;

try {
for (const compartmentId of compartmentIds) {
let page: string | undefined;

do {
apiCallCount += 1;
const response = await this.withProviderRetry(() => client.listInstances({
compartmentId,
...(page !== undefined ? { page } : {}),
}));

for (const instance of response.items ?? []) {
if (instance.id === undefined) continue;

const tags = this.mergeTags(instance.freeformTags, instance.definedTags);
resources.push({
tenantId: job.tenantId,
cloudConnectionId: job.cloudConnectionId,
provider: 'OCI',
externalResourceId: instance.id,
name: instance.displayName ?? instance.id,
resourceType: 'COMPUTE_INSTANCE',
serviceName: 'Oracle Compute',
...(job.connection.defaultRegion !== undefined ? { regionId: job.connection.defaultRegion } : {}),
status: this.normalizeResourceStatus(instance.lifecycleState),
tags,
rawResource: {
source: 'OCI_COMPUTE_SDK',
compartmentId,
shape: instance.shape,
lifecycleState: instance.lifecycleState,
},
});
}

page = response.opcNextPage;
} while (page !== undefined);
}

return {
apiCallCount,
resources,
coverage: {
inventoryCompartmentDiscovery: compartmentDiscovery.status,
configuredCompartmentCount: compartmentDiscovery.configuredCompartmentCount,
discoveredCompartmentCount: compartmentDiscovery.discoveredCompartmentCount,
compartmentCount: compartmentIds.length,
compartmentDiscoveryApiCalls: compartmentDiscovery.apiCallCount,
},
};
} finally {
client.close?.();
}
}

  private mergeInventoryResources(resources: readonly NormalizedCloudResource[]): readonly NormalizedCloudResource[] {
    const byExternalResourceId = new Map<string, NormalizedCloudResource>();
    for (const resource of resources) {
      const previous = byExternalResourceId.get(resource.externalResourceId);
      if (previous === undefined || previous.rawResource?.['source'] === 'OCI_METRIC_DEFINITION') {
        byExternalResourceId.set(resource.externalResourceId, resource);
      }
    }

    return [...byExternalResourceId.values()];
  }

private normalizeResourceStatus(status: string | undefined): NormalizedCloudResource['status'] {
const normalized = status?.toUpperCase();
if (normalized === 'ACTIVE' || normalized === 'RUNNING' || normalized === 'AVAILABLE') {
return 'ACTIVE';
    }

    if (normalized === 'STOPPED' || normalized === 'STOPPING') {
      return 'STOPPED';
    }

    if (normalized === 'TERMINATED' || normalized === 'DELETED') {
      return 'TERMINATED';
    }

return 'UNKNOWN';
}

private async listInventoryCompartmentIds(
job: CloudIngestionJobContext,
): Promise<{
readonly compartmentIds: readonly string[];
readonly apiCallCount: number;
readonly status: 'COMPLETE' | 'FALLBACK' | 'CONFIGURED_ONLY';
readonly configuredCompartmentCount: number;
readonly discoveredCompartmentCount: number;
}> {
const configuredCompartments = this.readConfiguredInventoryCompartments(job);
const compartmentIds = new Set(configuredCompartments);
if (getCredential(job.connection.credentials, [
'INVENTORY_READ',
'OPERATIONAL',
]) === undefined) {
return {
compartmentIds: [...compartmentIds],
apiCallCount: 0,
status: 'CONFIGURED_ONLY',
configuredCompartmentCount: configuredCompartments.length,
discoveredCompartmentCount: 0,
};
}
const client = this.createIdentityClient(this.createAuthProvider(job));
let apiCallCount = 0;
let discoveredCompartmentCount = 0;
let page: string | undefined;

try {
do {
apiCallCount += 1;
const response = await this.withProviderRetry(() => client.listCompartments({
compartmentId: job.connection.rootExternalId,
compartmentIdInSubtree: true,
accessLevel: 'ACCESSIBLE',
lifecycleState: 'ACTIVE',
limit: 1000,
...(page !== undefined ? { page } : {}),
}));
for (const compartment of response.items ?? []) {
if (compartment.id !== undefined && compartment.lifecycleState?.toUpperCase() === 'ACTIVE') {
compartmentIds.add(compartment.id);
discoveredCompartmentCount += 1;
}
}
page = response.opcNextPage;
} while (page !== undefined);
} catch {
// The identity policy may not allow compartment discovery. Keep explicitly
// configured compartments as a safe, deterministic fallback and let the
// inventory result report the reduced scope through its source/warnings.
return {
compartmentIds: [...compartmentIds],
apiCallCount,
status: 'FALLBACK',
configuredCompartmentCount: configuredCompartments.length,
discoveredCompartmentCount,
};
} finally {
client.close?.();
}

return {
compartmentIds: [...compartmentIds],
apiCallCount,
status: 'COMPLETE',
configuredCompartmentCount: configuredCompartments.length,
discoveredCompartmentCount,
};
}

private readConfiguredInventoryCompartments(job: CloudIngestionJobContext): readonly string[] {
const configured = readStringArray(job.connection.metadata?.['ociInventoryCompartments']);
const metricCompartments = readOciMetricDefinitions(job).map((definition) => definition.compartmentId);
return [...new Set([...configured, ...metricCompartments, job.connection.rootExternalId])];
}

private mergeTags(
freeformTags: Readonly<Record<string, unknown>> | undefined,
definedTags: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
return {
...(freeformTags ?? {}),
...(definedTags !== undefined ? { definedTags } : {}),
};
}

private readFocusObjects(job: CloudIngestionJobContext): readonly OciFocusReportObject[] {
return readObjectArray(job.connection.metadata, 'ociFocusReportObjects').map((item) => ({
      namespaceName: requireString(item['namespaceName'], 'ociFocusReportObjects.namespaceName'),
      bucketName: requireString(item['bucketName'], 'ociFocusReportObjects.bucketName'),
      objectName: requireString(item['objectName'], 'ociFocusReportObjects.objectName'),
      focusVersion: optionalString(item['focusVersion']) ?? '1.0',
    }));
  }

  private readFocusLocations(job: CloudIngestionJobContext): readonly OciFocusReportLocation[] {
    return readObjectArray(job.connection.metadata, 'ociFocusReportLocations').map((item) => {
      return {
        namespaceName: requireString(item['namespaceName'], 'ociFocusReportLocations.namespaceName'),
        bucketName: requireString(item['bucketName'], 'ociFocusReportLocations.bucketName'),
        prefix: requireString(item['prefix'], 'ociFocusReportLocations.prefix'),
        focusVersion: optionalString(item['focusVersion']) ?? '1.0',
        maxObjects: readBoundedPositiveInteger(item['maxObjects'], 100, 1, 1000),
      };
    });
  }

  private async discoverFocusObjects(
    job: CloudIngestionJobContext,
    client: OciObjectStorageClient,
    tolerateErrors = false,
  ): Promise<{ readonly objects: readonly OciFocusReportObject[]; readonly apiCallCount: number; readonly errors: readonly string[] }> {
    const locations = this.readFocusLocations(job);
    const discovered: OciFocusReportObject[] = [];
    let apiCallCount = 0;
    const errors: string[] = [];

    for (const location of locations) {
      let start: string | undefined;
      const locationStartCount = discovered.length;

      try {
      while (discovered.length - locationStartCount < location.maxObjects) {
        apiCallCount += 1;
        const response = await this.withProviderRetry(() => client.listObjects({
          namespaceName: location.namespaceName,
          bucketName: location.bucketName,
          prefix: location.prefix,
          limit: Math.min(1000, location.maxObjects - (discovered.length - locationStartCount)),
          ...(start !== undefined ? { start } : {}),
        }));

        for (const object of response.listObjects?.objects ?? []) {
          if (object.name === undefined || !this.isFocusObjectName(object.name)) {
            continue;
          }

          discovered.push({
            namespaceName: location.namespaceName,
            bucketName: location.bucketName,
            objectName: object.name,
            focusVersion: location.focusVersion,
            ...(object.size !== undefined ? { sizeBytes: object.size } : {}),
            ...(object.timeModified !== undefined ? { lastModified: object.timeModified } : {}),
          });
        }

        if (response.listObjects?.nextStartWith === undefined) {
          break;
        }

        start = response.listObjects.nextStartWith;
      }
      } catch (error) {
        if (!tolerateErrors) throw error;
        errors.push(`${location.namespaceName}/${location.bucketName}: ${safeOciProviderError(error)}`);
      }
    }

    return { objects: discovered, apiCallCount, errors };
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

  private isFocusObjectName(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.csv') || lower.endsWith('.csv.gz');
  }

  private async withProviderRetry<T>(operation: () => Promise<T>): Promise<T> {
    const delaysMs = [1000, 2500, 5000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isRateLimitError(error) || attempt === delaysMs.length) {
          throw error;
        }

        await this.sleep(delaysMs[attempt]!);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('OCI operation failed after retries');
  }

  private isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /rate exceeded|too many requests|429/i.test(message);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

function buildOciFocusPreviewResult(
  configuredLocations: number,
  configuredObjects: number,
  discoveredObjects: number,
  objects: FocusSourcePreviewResult['objects'],
  errors: readonly string[],
): FocusSourcePreviewResult {
  const dates = objects.flatMap((object) => object.lastModified === undefined ? [] : [object.lastModified]);
  return {
    providerCode: 'oci',
    configuredLocations,
    configuredObjects,
    discoveredObjects,
    approximateBytes: objects.reduce((sum, object) => sum + (object.sizeBytes ?? 0), 0),
    sizedObjects: objects.filter((object) => object.sizeBytes !== undefined).length,
    supportedFormats: ['csv', 'csv.gz'],
    errors,
    ...(dates.length > 0 ? {
      earliestObjectAt: new Date(Math.min(...dates.map((date) => date.getTime()))),
      latestObjectAt: new Date(Math.max(...dates.map((date) => date.getTime()))),
    } : {}),
    objects,
  };
}
