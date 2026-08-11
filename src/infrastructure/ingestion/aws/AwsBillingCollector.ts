import { GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionConnection,
  CloudIngestionJobContext,
  CloudIngestionResult,
  FocusSourcePreviewResult,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { parseFocusCsvStream, toAsyncByteChunks } from '../focusCsvIngestion.js';
import { resolveBillingSource } from '../billingSourceMode.js';
import { getCredential, optionalString } from '../providerConfig.js';
import type {
  AwsCommandClient,
  AwsCostExplorerResponse,
  AwsFocusExportObject,
  AwsGetObjectResponse,
  AwsListObjectsResponse,
} from './awsContracts.js';
import {
  isAwsFocusObjectName,
  readAwsFocusLocations,
  readAwsFocusObjects,
  safeAwsProviderError,
} from './awsConfiguration.js';

interface AwsBillingCollectorDependencies {
  readonly assumeRole: (
    credential: NonNullable<ReturnType<typeof getCredential>>,
    region: string,
  ) => Promise<AwsCredentialIdentity>;
  readonly createS3Client: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsGetObjectResponse & AwsListObjectsResponse>;
  readonly createCostExplorerClient: (
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsCostExplorerResponse>;
}

export async function previewAwsFocus(
  connection: CloudIngestionConnection,
  limit: number,
  dependencies: AwsBillingCollectorDependencies,
): Promise<FocusSourcePreviewResult> {
  const credential = getCredential(connection.credentials, ['BILLING_EXPORT_READ', 'STORAGE_READ', 'OPERATIONAL']);
  if (credential === undefined) throw new Error('No hay una credencial AWS activa para leer el export FOCUS.');
  const region = optionalString(credential.payload['region']) ?? connection.defaultRegion ?? 'us-east-1';
  const credentials = await dependencies.assumeRole(credential, region);
  const job = buildAwsPreviewJob(connection);
  const configured = readAwsFocusObjects(job);
  const discovery = await discoverFocusObjects(job, credentials, region, dependencies, true);
  const objects = [
    ...configured.map((object) => ({ object, source: 'configured' as const })),
    ...discovery.objects.map((object) => ({ object, source: 'discovered' as const })),
  ].slice(0, limit).map(({ object, source }) => ({
    name: object.key,
    location: `s3://${object.bucket}/${object.key}`,
    source,
    ...(object.sizeBytes !== undefined ? { sizeBytes: object.sizeBytes } : {}),
    ...(object.lastModified !== undefined ? { lastModified: object.lastModified } : {}),
  }));
  return buildFocusPreviewResult(
    readAwsFocusLocations(job).length,
    configured.length,
    discovery.objects.length,
    objects,
    discovery.errors,
  );
}

export async function collectAwsBilling(
  job: CloudIngestionJobContext,
  dependencies: AwsBillingCollectorDependencies,
): Promise<CloudIngestionResult> {
  if (resolveBillingSource(job) === 'PROVIDER_API') return collectProviderApiCosts(job, dependencies);
  const credential = getCredential(job.connection.credentials, ['BILLING_EXPORT_READ', 'STORAGE_READ', 'OPERATIONAL']);
  if (credential === undefined) throw new Error('AWS BILLING_EXPORT_READ, STORAGE_READ or OPERATIONAL credential is required');

  const baseRegion = job.connection.defaultRegion ?? 'us-east-1';
  const assumed = await dependencies.assumeRole(credential, baseRegion);
  const discovery = await discoverFocusObjects(job, assumed, baseRegion, dependencies);
  const objects = [...readAwsFocusObjects(job), ...discovery.objects];
  if (objects.length === 0) {
    return emptyAwsResult(['No AWS FOCUS export objects configured or discovered. Configure awsFocusExportObjects or awsFocusExportLocations.'], {
      costSource: 'AWS Data Exports FOCUS to S3',
      objectsConfigured: 0,
      prefixesConfigured: readAwsFocusLocations(job).length,
    });
  }

  return {
    apiCallCount: 1 + discovery.apiCallCount + objects.length,
    objectsProcessed: objects.length,
    focusRows: [],
    focusBatches: streamFocusObjects(job, assumed, baseRegion, objects, dependencies),
    resources: [],
    metricSamples: [],
    warnings: [],
    coverage: {
      costSource: 'AWS Data Exports FOCUS to S3',
      objectsConfigured: objects.length,
      objectsDiscovered: discovery.objects.length,
      prefixesConfigured: readAwsFocusLocations(job).length,
      rowsParsed: 'streamed',
    },
  };
}

async function collectProviderApiCosts(
  job: CloudIngestionJobContext,
  dependencies: AwsBillingCollectorDependencies,
): Promise<CloudIngestionResult> {
  const credential = getCredential(job.connection.credentials, ['BILLING_EXPORT_READ', 'OPERATIONAL']);
  if (credential === undefined) throw new Error('AWS BILLING_EXPORT_READ or OPERATIONAL credential is required');
  const region = job.connection.defaultRegion ?? 'us-east-1';
  const credentials = await dependencies.assumeRole(credential, region);
  const client = dependencies.createCostExplorerClient(credentials);
  const rows: NormalizedProviderCostLineItem[] = [];
  let nextPageToken: string | undefined;
  let apiCallCount = 1;
  do {
    const response = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: job.targetStart.toISOString().slice(0, 10), End: job.targetEnd.toISOString().slice(0, 10) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost', 'UsageQuantity'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      ...(nextPageToken === undefined ? {} : { NextPageToken: nextPageToken }),
    }));
    apiCallCount += 1;
    addCostExplorerRows(rows, job, response);
    nextPageToken = response.NextPageToken;
  } while (nextPageToken !== undefined);

  return {
    apiCallCount,
    objectsProcessed: 0,
    focusRows: [],
    providerCostRows: rows,
    resources: [],
    metricSamples: [],
    warnings: rows.length === 0 ? ['AWS Cost Explorer returned no costs for the requested range.'] : [],
    coverage: { billingSource: 'PROVIDER_API', costSource: 'AWS Cost Explorer', rows: rows.length },
  };
}

function addCostExplorerRows(
  rows: NormalizedProviderCostLineItem[],
  job: CloudIngestionJobContext,
  response: AwsCostExplorerResponse,
): void {
  for (const day of response.ResultsByTime ?? []) {
    const start = day.TimePeriod?.Start;
    const end = day.TimePeriod?.End;
    if (start === undefined || end === undefined) continue;
    for (const group of day.Groups ?? []) {
      const cost = Number(group.Metrics?.['UnblendedCost']?.Amount ?? '0');
      if (!Number.isFinite(cost)) continue;
      const serviceName = group.Keys?.[0] ?? 'Uncategorized';
      const usage = Number(group.Metrics?.['UsageQuantity']?.Amount ?? '');
      const rawRow = { start, end, serviceName, metrics: group.Metrics ?? {} };
      rows.push({
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        provider: 'AWS',
        chargePeriodStart: new Date(`${start}T00:00:00.000Z`),
        chargePeriodEnd: new Date(`${end}T00:00:00.000Z`),
        billingAccountId: job.connection.rootExternalId,
        serviceName,
        resourceId: '',
        billedCost: cost,
        billingCurrency: group.Metrics?.['UnblendedCost']?.Unit ?? 'USD',
        ...(Number.isFinite(usage) ? { consumedQuantity: usage, consumedUnit: group.Metrics?.['UsageQuantity']?.Unit ?? 'N/A' } : {}),
        sourceMetric: 'AWS_UNBLENDED_COST',
        rawRow,
        lineItemHash: createHash('sha256').update(JSON.stringify(rawRow)).digest('hex'),
      });
    }
  }
}

async function* streamFocusObjects(
  job: CloudIngestionJobContext,
  credentials: AwsCredentialIdentity,
  baseRegion: string,
  objects: readonly AwsFocusExportObject[],
  dependencies: AwsBillingCollectorDependencies,
): AsyncGenerator<readonly NormalizedFocusCostLineItem[]> {
  const batch: NormalizedFocusCostLineItem[] = [];
  for (const object of objects) {
    const client = dependencies.createS3Client(object.region ?? baseRegion, credentials);
    const response = await client.send(new GetObjectCommand({ Bucket: object.bucket, Key: object.key }));
    for await (const line of parseFocusCsvStream(toAsyncByteChunks(response.Body), {
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      provider: 'AWS',
      focusVersion: object.focusVersion,
    }, object.key)) {
      batch.push(line);
      if (batch.length >= 1000) yield batch.splice(0, batch.length);
    }
  }
  if (batch.length > 0) yield batch;
}

async function discoverFocusObjects(
  job: CloudIngestionJobContext,
  credentials: AwsCredentialIdentity,
  defaultRegion: string,
  dependencies: AwsBillingCollectorDependencies,
  tolerateErrors = false,
): Promise<{ readonly objects: readonly AwsFocusExportObject[]; readonly apiCallCount: number; readonly errors: readonly string[] }> {
  const discovered: AwsFocusExportObject[] = [];
  let apiCallCount = 0;
  const errors: string[] = [];
  for (const location of readAwsFocusLocations(job)) {
    const client = dependencies.createS3Client(location.region ?? defaultRegion, credentials);
    let continuationToken: string | undefined;
    const locationStartCount = discovered.length;
    try {
      while (discovered.length - locationStartCount < location.maxObjects) {
        apiCallCount += 1;
        const response = await client.send(new ListObjectsV2Command({
          Bucket: location.bucket,
          Prefix: location.prefix,
          MaxKeys: Math.min(1000, location.maxObjects - (discovered.length - locationStartCount)),
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }));
        for (const object of response.Contents ?? []) {
          if (object.Key === undefined || !isAwsFocusObjectName(object.Key)) continue;
          discovered.push({
            bucket: location.bucket,
            key: object.Key,
            focusVersion: location.focusVersion,
            ...(object.Size !== undefined ? { sizeBytes: object.Size } : {}),
            ...(object.LastModified !== undefined ? { lastModified: object.LastModified } : {}),
            ...(location.region !== undefined ? { region: location.region } : {}),
          });
        }
        if (response.IsTruncated !== true || response.NextContinuationToken === undefined) break;
        continuationToken = response.NextContinuationToken;
      }
    } catch (error) {
      if (!tolerateErrors) throw error;
      errors.push(`${location.bucket}/${location.prefix}: ${safeAwsProviderError(error)}`);
    } finally {
      client.destroy?.();
    }
  }
  return { objects: discovered, apiCallCount, errors };
}

function emptyAwsResult(
  warnings: readonly string[],
  coverage: Readonly<Record<string, unknown>>,
): CloudIngestionResult {
  return { apiCallCount: 0, objectsProcessed: 0, focusRows: [], resources: [], metricSamples: [], warnings, coverage };
}

function buildAwsPreviewJob(connection: CloudIngestionConnection): CloudIngestionJobContext {
  const targetEnd = new Date();
  return {
    id: `focus-preview-${connection.id}`,
    tenantId: connection.tenantId,
    cloudConnectionId: connection.id,
    sourceType: 'BILLING_EXPORT',
    targetStart: new Date(targetEnd.getTime() - 24 * 60 * 60 * 1000),
    targetEnd,
    attempt: 0,
    connection,
  };
}

function buildFocusPreviewResult(
  configuredLocations: number,
  configuredObjects: number,
  discoveredObjects: number,
  objects: FocusSourcePreviewResult['objects'],
  errors: readonly string[],
): FocusSourcePreviewResult {
  const dates = objects.flatMap((object) => object.lastModified === undefined ? [] : [object.lastModified]);
  return {
    providerCode: 'aws',
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
