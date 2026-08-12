import { createHash } from 'node:crypto';
import * as usageapi from 'oci-usageapi';
import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { parseFocusCsvStream, toAsyncByteChunks } from '../focusCsvIngestion.js';
import { resolveBillingSource } from '../billingSourceMode.js';
import type {
  OciFocusReportObject,
  OciObjectStorageClient,
  OciUsageClient,
} from './OciSdkContracts.js';
import {
  discoverOciFocusObjects,
  readOciFocusLocations,
  readOciFocusObjects,
} from './OciFocusSource.js';
import { withOciProviderRetry } from './OciRetryPolicy.js';

export interface OciBillingCollectorDependencies {
  createObjectStorageClient(job: CloudIngestionJobContext): OciObjectStorageClient;
  createUsageClient(job: CloudIngestionJobContext): OciUsageClient;
}

/** Handles OCI billing sources without coupling FOCUS parsing to the provider facade. */
export class OciBillingCollector {
  constructor(private readonly dependencies: OciBillingCollectorDependencies) {}

  public collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    return resolveBillingSource(job) === 'PROVIDER_API'
      ? this.collectProviderApiCosts(job)
      : this.collectFocusExport(job);
  }

  private async collectFocusExport(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    const client = this.dependencies.createObjectStorageClient(job);
    let discovery: Awaited<ReturnType<typeof discoverOciFocusObjects>>;
    try {
      discovery = await discoverOciFocusObjects(job, client, withOciProviderRetry);
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

    return {
      apiCallCount: discovery.apiCallCount + objects.length,
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
    const client = this.dependencies.createUsageClient(job);
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
        const rawRow = {
          ...item,
          targetStart: job.targetStart.toISOString(),
          targetEnd: job.targetEnd.toISOString(),
        };
        rows.push({
          tenantId: job.tenantId,
          cloudConnectionId: job.cloudConnectionId,
          provider: 'OCI',
          chargePeriodStart: job.targetStart,
          chargePeriodEnd: job.targetEnd,
          billingAccountId: job.connection.rootExternalId,
          serviceName: item.service ?? 'Uncategorized',
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
      return {
        apiCallCount: 1,
        objectsProcessed: 0,
        focusRows: [],
        providerCostRows: rows,
        resources: [],
        metricSamples: [],
        warnings: rows.length === 0 ? ['OCI Usage API returned no costs for the requested range.'] : [],
        coverage: { billingSource: 'PROVIDER_API', costSource: 'OCI Usage API', rows: rows.length },
      };
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
          if (batch.length >= 1000) yield batch.splice(0, batch.length);
        }
      }
      if (batch.length > 0) yield batch;
    } finally {
      client.close?.();
    }
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
