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
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { parseFocusCsvStream, toAsyncByteChunks } from './focusCsvIngestion.js';
import {
  getCredential,
  optionalString,
  readObjectArray,
  requireString,
} from './providerConfig.js';
import { resolveBillingSource } from './billingSourceMode.js';
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
  OciFocusReportObject,
  OciIdentityClient,
  OciMonitoringClient,
  OciObjectStorageClient,
  OciUsageClient,
} from './oci/OciSdkContracts.js';
import { collectOciInventory } from './oci/OciInventoryCollector.js';
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
      return this.collectBillingExport(job);
    }

    if (job.sourceType === 'INVENTORY') {
      const inventory = await collectOciInventory(job, {
        createComputeClient: (context) => this.createComputeClient(context),
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

  private async collectBillingExport(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (resolveBillingSource(job) === 'PROVIDER_API') {
      return this.collectProviderApiCosts(job);
    }
    const client = this.createObjectStorageClient(job);
    let discovery: Awaited<ReturnType<typeof discoverOciFocusObjects>>;
    try {
      discovery = await discoverOciFocusObjects(
        job,
        client,
        withOciProviderRetry,
      );
    } catch (error) {
      client.close?.();
      throw error;
    }
    const objects = [...readOciFocusObjects(job), ...discovery.objects];
    if (objects.length === 0) {
      client.close?.();
      return this.emptyResult(0, [
        'No OCI FOCUS report objects configured or discovered. Configure ociFocusReportObjects or ociFocusReportLocations.',
      ], {
        costSource: 'OCI Cost Reports FOCUS',
        expectedRefreshHours: 6,
        objectsConfigured: 0,
        prefixesConfigured: readOciFocusLocations(job).length,
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
        prefixesConfigured: readOciFocusLocations(job).length,
        rowsParsed: 'streamed',
      },
    };
  }

  private async collectProviderApiCosts(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    const provider = this.createAuthProvider(job);
    const client = new usageapi.UsageapiClient({ authenticationDetailsProvider: provider }) as unknown as OciUsageClient;
    try {
    const response = await withOciProviderRetry(() => client.requestSummarizedUsages({
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
      const response = await withOciProviderRetry(() => client.getObject({
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
