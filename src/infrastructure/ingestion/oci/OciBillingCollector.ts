import { createHash } from 'node:crypto';
import * as usageapi from 'oci-usageapi';
import type {
  CloudIngestionJobContext,
  CloudIngestionCollectOptions,
  CloudIngestionResult,
  IngestionObjectDescriptor,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { parseFocusCsvStream, toAsyncByteChunks } from '../focusCsvIngestion.js';
import { readBillingSourceMode, resolveBillingSource } from '../billingSourceMode.js';
import type {
  OciFocusReportObject,
  OciObjectStorageClient,
  OciUsageClient,
} from './OciSdkContracts.js';
import {
  discoverOciFocusObjects,
  isOciFocusObjectInWindow,
  readOciFocusLocations,
  readOciFocusObjects,
} from './OciFocusSource.js';
import { safeOciProviderError } from './OciCapabilityValidator.js';
import { withOciProviderRetry } from './OciRetryPolicy.js';
import { normalizeOciDailyUsageRange } from './OciUsageDateRange.js';

export interface OciBillingCollectorDependencies {
  createObjectStorageClient(job: CloudIngestionJobContext, signal?: AbortSignal): OciObjectStorageClient;
  createUsageClient(job: CloudIngestionJobContext, signal?: AbortSignal): OciUsageClient;
  withRateLimit?<T>(
    job: CloudIngestionJobContext,
    api: 'objectstorage' | 'usage',
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Handles OCI billing sources without coupling FOCUS parsing to the provider facade. */
export class OciBillingCollector {
  constructor(private readonly dependencies: OciBillingCollectorDependencies) {}

  public async collect(
    job: CloudIngestionJobContext,
    options: CloudIngestionCollectOptions = {},
  ): Promise<CloudIngestionResult> {
    const configuredMode = readBillingSourceMode(job.connection.metadata);
    if (resolveBillingSource(job) === 'PROVIDER_API') {
      return this.collectProviderApiCosts(job, options);
    }

    try {
      const focus = await this.collectFocusExport(job, options);
      const objectsConfigured = readCoverageNumber(focus.coverage, 'objectsConfigured')
        ?? readCoverageNumber(focus.coverage, 'objectsProcessed')
        ?? 0;
      if (configuredMode !== 'FOCUS' && objectsConfigured === 0) {
        return this.collectProviderApiWithFallback(
          job,
          focus.warnings[0] ?? 'No se encontraron objetos de reporte FOCUS OCI para el periodo solicitado.',
          focus.coverage,
          options,
        );
      }
      return focus;
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      if (configuredMode === 'FOCUS') throw error;
      return this.collectProviderApiWithFallback(job, 'FOCUS no estuvo disponible; se usó OCI Usage API como fallback.', undefined, options);
    }
  }

  private async collectFocusExport(
    job: CloudIngestionJobContext,
    options: CloudIngestionCollectOptions,
  ): Promise<CloudIngestionResult> {
    const client = this.dependencies.createObjectStorageClient(job, options.signal);
    let discovery: Awaited<ReturnType<typeof discoverOciFocusObjects>>;
    try {
      discovery = await discoverOciFocusObjects(
        job,
        client,
        (operation, signal) => withOciProviderRetry(operation, undefined, undefined, undefined, signal),
        false,
        (operation, signal) => this.call(job, 'objectstorage', operation, signal),
        options.signal,
        true,
      );
    } catch (error) {
      client.close?.();
      throw error;
    }

    const discoveredObjects = uniqueFocusObjects([...readOciFocusObjects(job), ...discovery.objects]);
    const objects = discoveredObjects.filter((object) => isOciFocusObjectInWindow(object.objectName, job));
    if (objects.length === 0) {
      client.close?.();
      return this.emptyResult(discovery.apiCallCount, [
        discoveredObjects.length === 0
          ? 'No se encontraron objetos de reporte FOCUS OCI configurados o descubiertos. Configura ociFocusReportObjects u ociFocusReportLocations.'
          : 'No se encontraron objetos de reporte FOCUS OCI para el periodo solicitado.',
      ], {
        costSource: 'OCI Cost Reports FOCUS',
        expectedRefreshHours: 6,
        apiCallCount: discovery.apiCallCount,
        objectsConfigured: 0,
        objectsDiscovered: discovery.objects.length,
        objectsExcludedByRange: discoveredObjects.length,
        prefixesConfigured: readOciFocusLocations(job).length,
      });
    }

    return {
      apiCallCount: discovery.apiCallCount + objects.length,
      objectsProcessed: objects.length,
      sourceObjects: objects.map(toIngestionObjectDescriptor),
      focusRows: [],
      focusBatches: this.streamFocusObjects(job, client, objects, options),
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

  private async collectProviderApiCosts(
    job: CloudIngestionJobContext,
    options: CloudIngestionCollectOptions,
  ): Promise<CloudIngestionResult> {
    const client = this.dependencies.createUsageClient(job, options.signal);
    try {
      const range = normalizeOciDailyUsageRange(job.targetStart, job.targetEnd);
      const rows: NormalizedProviderCostLineItem[] = [];
      let itemsWithoutCurrency = 0;
      let nextPage: string | undefined;
      let apiCallCount = 0;
      do {
        await ensureNotCancelled(options);
        const response = await this.call(job, 'usage', () => withOciProviderRetry(() => client.requestSummarizedUsages({
          ...(nextPage !== undefined ? { page: nextPage } : {}),
          requestSummarizedUsagesDetails: {
            tenantId: job.connection.rootExternalId,
            timeUsageStarted: range.start,
            timeUsageEnded: range.end,
            granularity: usageapi.models.RequestSummarizedUsagesDetails.Granularity.Daily,
            queryType: usageapi.models.RequestSummarizedUsagesDetails.QueryType.Cost,
             groupBy: ['service', 'resourceId', 'region', 'skuName'],
          },
        }), undefined, undefined, undefined, options.signal), options.signal);
        apiCallCount += 1;
        for (const item of response.usageAggregation?.items ?? []) {
        const amount = item.computedAmount;
        if (amount === undefined || !Number.isFinite(amount)) continue;
        const chargePeriodStart = parseUsageTimestamp(item.timeUsageStarted, range.start);
        const chargePeriodEnd = parseUsageTimestamp(item.timeUsageEnded, range.end);
        const rawRow = {
          ...item,
          chargePeriodStart: chargePeriodStart.toISOString(),
          chargePeriodEnd: chargePeriodEnd.toISOString(),
        };
        if (item.currency === undefined) itemsWithoutCurrency += 1;
        rows.push({
          tenantId: job.tenantId,
          cloudConnectionId: job.cloudConnectionId,
          provider: 'OCI',
          chargePeriodStart,
          chargePeriodEnd,
          billingAccountId: job.connection.rootExternalId,
          serviceName: item.service ?? 'Uncategorized',
          resourceId: item.resourceId ?? '',
          ...(item.resourceName === undefined ? {} : { resourceName: item.resourceName }),
          ...(item.region === undefined ? {} : { regionId: item.region }),
          ...(item.compartmentId === undefined ? {} : { compartmentId: item.compartmentId }),
          ...(item.skuName === undefined ? {} : { skuName: item.skuName }),
          ...(item.skuPartNumber === undefined ? {} : { skuPartNumber: item.skuPartNumber }),
          billedCost: amount,
          billingCurrency: item.currency ?? 'USD',
          ...(item.computedQuantity === undefined ? {} : { consumedQuantity: item.computedQuantity }),
          ...(item.unit === undefined ? {} : { consumedUnit: item.unit }),
          sourceMetric: 'OCI_COMPUTED_AMOUNT',
          rawRow,
          lineItemHash: createHash('sha256').update(JSON.stringify(rawRow)).digest('hex'),
        });
        }
        nextPage = response.opcNextPage;
      } while (nextPage !== undefined && nextPage !== '');
      return {
        apiCallCount,
        objectsProcessed: 0,
        focusRows: [],
        providerCostRows: rows,
        resources: [],
        metricSamples: [],
         warnings: [
           ...(rows.length === 0 ? ['OCI Usage API returned no costs for the requested range.'] : []),
           ...(itemsWithoutCurrency > 0 ? [`OCI Usage API omitted currency for ${itemsWithoutCurrency} rows; USD was used as the compatibility fallback.`] : []),
         ],
         coverage: { billingSource: 'PROVIDER_API', costSource: 'OCI Usage API', rows: rows.length, groupedBy: ['service', 'resourceId', 'region', 'skuName'], itemsWithoutCurrency },
      };
    } finally {
      client.close?.();
    }
  }

  private async collectProviderApiWithFallback(
    job: CloudIngestionJobContext,
    warning: string,
    focusCoverage?: Readonly<Record<string, unknown>>,
    options: CloudIngestionCollectOptions = {},
  ): Promise<CloudIngestionResult> {
    try {
      const result = await this.collectProviderApiCosts(job, options);
      return {
        ...result,
        warnings: [warning, ...result.warnings],
        coverage: {
          ...result.coverage,
          billingSourceFallback: 'FOCUS_TO_PROVIDER_API',
          ...(focusCoverage === undefined ? {} : { focusCoverage }),
        },
      };
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      // AUTO is deliberately best-effort: a missing current FOCUS object plus
      // a tenant without Usage API permission must not turn the scheduler
      // into a permanently failing retry loop. Preserve the gap as a partial
      // coverage result so the next run can retry after reports are published
      // or permissions are corrected. Explicit FOCUS/PROVIDER_API modes still
      // fail fast in their respective collectors.
      return this.emptyResult(readCoverageNumber(focusCoverage, 'apiCallCount') ?? 0, [
        warning,
        'OCI Usage API tampoco estuvo disponible; el periodo queda pendiente de una nueva sincronizacion.',
      ], {
        billingSource: 'OCI Cost Reports FOCUS',
        billingSourceFallback: 'FOCUS_TO_PROVIDER_API',
        fallbackError: safeOciProviderError(error),
        apiCallCount: readCoverageNumber(focusCoverage, 'apiCallCount') ?? 0,
        ...(focusCoverage === undefined ? {} : { focusCoverage }),
      });
    }
  }

  private async *streamFocusObjects(
    job: CloudIngestionJobContext,
    client: OciObjectStorageClient,
    objects: readonly OciFocusReportObject[],
    options: CloudIngestionCollectOptions,
  ): AsyncGenerator<readonly NormalizedFocusCostLineItem[]> {
    const batch: NormalizedFocusCostLineItem[] = [];
    try {
      for (const object of objects) {
        await ensureNotCancelled(options);
        const response = await this.call(job, 'objectstorage', () => withOciProviderRetry(() => client.getObject({
          namespaceName: object.namespaceName,
          bucketName: object.bucketName,
          objectName: object.objectName,
        }), undefined, undefined, undefined, options.signal), options.signal);
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
          if (!isFocusRowInWindow(line, job)) continue;
          batch.push(line);
          if (batch.length >= 1000) {
            await ensureNotCancelled(options);
            yield batch.splice(0, batch.length);
          }
        }
      }
      if (batch.length > 0) {
        await ensureNotCancelled(options);
        yield batch;
      }
    } finally {
      client.close?.();
    }
  }

  private call<T>(
    job: CloudIngestionJobContext,
    api: 'objectstorage' | 'usage',
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.dependencies.withRateLimit === undefined
      ? operation()
      : this.dependencies.withRateLimit(job, api, operation, signal);
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

function toIngestionObjectDescriptor(object: OciFocusReportObject): IngestionObjectDescriptor {
  return {
    objectUri: `${object.namespaceName}/${object.bucketName}/${object.objectName}`,
    ...(object.sizeBytes === undefined ? {} : { sizeBytes: object.sizeBytes }),
    ...(object.lastModified === undefined ? {} : { lastModified: object.lastModified }),
  };
}

function isFocusRowInWindow(
  row: NormalizedFocusCostLineItem,
  job: CloudIngestionJobContext,
): boolean {
  return row.chargePeriodEnd > job.targetStart && row.chargePeriodStart < job.targetEnd;
}

function uniqueFocusObjects(objects: readonly OciFocusReportObject[]): readonly OciFocusReportObject[] {
  const byKey = new Map<string, OciFocusReportObject>();
  for (const object of objects) {
    byKey.set(`${object.namespaceName}/${object.bucketName}/${object.objectName}`, object);
  }
  return [...byKey.values()];
}

function readCoverageNumber(coverage: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  if (coverage === undefined) return undefined;
  const value = coverage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseUsageTimestamp(value: Date | string | undefined, fallback: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

async function ensureNotCancelled(options: CloudIngestionCollectOptions): Promise<void> {
  if (options.signal?.aborted === true) throw new Error('OCI provider request cancelled');
  if (options.isCancellationRequested !== undefined && await options.isCancellationRequested()) {
    throw new Error('OCI provider request cancelled');
  }
}
