import type {
  CloudIngestionJobContext,
  FocusSourcePreviewResult,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  optionalString,
  readBoundedPositiveInteger,
  readObjectArray,
  requireString,
} from '../providerConfig.js';
import { safeOciProviderError } from './OciCapabilityValidator.js';
import type {
  OciFocusReportLocation,
  OciFocusReportObject,
  OciObjectStorageClient,
} from './OciSdkContracts.js';

export function readOciFocusObjects(
  job: CloudIngestionJobContext,
): readonly OciFocusReportObject[] {
  return readObjectArray(job.connection.metadata, 'ociFocusReportObjects').map((item) => ({
    namespaceName: requireString(item['namespaceName'], 'ociFocusReportObjects.namespaceName'),
    bucketName: requireString(item['bucketName'], 'ociFocusReportObjects.bucketName'),
    objectName: requireString(item['objectName'], 'ociFocusReportObjects.objectName'),
    focusVersion: optionalString(item['focusVersion']) ?? '1.0',
  }));
}

export function readOciFocusLocations(
  job: CloudIngestionJobContext,
): readonly OciFocusReportLocation[] {
  return readObjectArray(job.connection.metadata, 'ociFocusReportLocations').map((item) => ({
    namespaceName: requireString(item['namespaceName'], 'ociFocusReportLocations.namespaceName'),
    bucketName: requireString(item['bucketName'], 'ociFocusReportLocations.bucketName'),
    prefix: requireString(item['prefix'], 'ociFocusReportLocations.prefix'),
    focusVersion: optionalString(item['focusVersion']) ?? '1.0',
    maxObjects: readBoundedPositiveInteger(item['maxObjects'], 100, 1, 1000),
  }));
}

export async function discoverOciFocusObjects(
  job: CloudIngestionJobContext,
  client: OciObjectStorageClient,
  withRetry: <T>(operation: () => Promise<T>) => Promise<T>,
  tolerateErrors = false,
): Promise<{
  readonly objects: readonly OciFocusReportObject[];
  readonly apiCallCount: number;
  readonly errors: readonly string[];
}> {
  const discovered: OciFocusReportObject[] = [];
  let apiCallCount = 0;
  const errors: string[] = [];

  for (const location of readOciFocusLocations(job)) {
    let start: string | undefined;
    const locationStartCount = discovered.length;
    try {
      while (discovered.length - locationStartCount < location.maxObjects) {
        apiCallCount += 1;
        const response = await withRetry(() => client.listObjects({
          namespaceName: location.namespaceName,
          bucketName: location.bucketName,
          prefix: location.prefix,
          limit: Math.min(1000, location.maxObjects - (discovered.length - locationStartCount)),
          ...(start !== undefined ? { start } : {}),
        }));

        for (const object of response.listObjects?.objects ?? []) {
          if (object.name === undefined || !isFocusObjectName(object.name)) continue;
          discovered.push({
            namespaceName: location.namespaceName,
            bucketName: location.bucketName,
            objectName: object.name,
            focusVersion: location.focusVersion,
            ...(object.size !== undefined ? { sizeBytes: object.size } : {}),
            ...(object.timeModified !== undefined ? { lastModified: object.timeModified } : {}),
          });
        }

        if (response.listObjects?.nextStartWith === undefined) break;
        start = response.listObjects.nextStartWith;
      }
    } catch (error) {
      if (!tolerateErrors) throw error;
      errors.push(`${location.namespaceName}/${location.bucketName}: ${safeOciProviderError(error)}`);
    }
  }

  return { objects: discovered, apiCallCount, errors };
}

export function buildOciFocusPreviewResult(
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

function isFocusObjectName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.csv') || lower.endsWith('.csv.gz');
}
