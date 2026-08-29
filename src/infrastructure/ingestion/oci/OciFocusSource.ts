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

/**
 * Cost Reports can contain several years of daily split objects. The old
 * 1,000-object default stopped discovery at the oldest page and made recent
 * reports invisible. Keep a bounded safety valve, but make it large enough
 * for a normal historical backfill after applying the job window filter.
 */
export const OCI_FOCUS_DEFAULT_MAX_OBJECTS = 10_000;
export const OCI_FOCUS_MAX_OBJECTS = 10_000;

export function readOciFocusObjects(
  job: CloudIngestionJobContext,
): readonly OciFocusReportObject[] {
  return readObjectArray(job.connection.metadata, 'ociFocusReportObjects').map((item) => ({
    namespaceName: requireString(readMetadataField(item, 'namespaceName', 'namespace-name'), 'ociFocusReportObjects.namespaceName'),
    bucketName: requireString(readMetadataField(item, 'bucketName', 'bucket-name'), 'ociFocusReportObjects.bucketName'),
    objectName: requireString(readMetadataField(item, 'objectName', 'object-name'), 'ociFocusReportObjects.objectName'),
    focusVersion: optionalString(readMetadataField(item, 'focusVersion', 'focus-version')) ?? '1.0',
  }));
}

export function readOciFocusLocations(
  job: CloudIngestionJobContext,
): readonly OciFocusReportLocation[] {
  const configured = readObjectArray(job.connection.metadata, 'ociFocusReportLocations').map((item) => ({
    namespaceName: requireString(readMetadataField(item, 'namespaceName', 'namespace-name'), 'ociFocusReportLocations.namespaceName'),
    bucketName: requireString(readMetadataField(item, 'bucketName', 'bucket-name'), 'ociFocusReportLocations.bucketName'),
    prefix: requireString(readMetadataField(item, 'prefix'), 'ociFocusReportLocations.prefix'),
    focusVersion: optionalString(readMetadataField(item, 'focusVersion', 'focus-version')) ?? '1.0',
    maxObjects: readBoundedPositiveInteger(
      readMetadataField(item, 'maxObjects', 'max-objects'),
      OCI_FOCUS_DEFAULT_MAX_OBJECTS,
      1,
      OCI_FOCUS_MAX_OBJECTS,
    ),
  }));
  if (configured.length > 0 || readObjectArray(job.connection.metadata, 'ociFocusReportObjects').length > 0) {
    return configured;
  }

  // OCI-managed Cost Reports use a provider-managed Object Storage namespace,
  // the tenancy OCID as bucket and the well-known report prefix. Keep this
  // convention automatic; explicit metadata still overrides it completely.
  return [{
    namespaceName: 'bling',
    bucketName: job.connection.rootExternalId,
    prefix: 'FOCUS Reports',
    focusVersion: '1.0',
    maxObjects: OCI_FOCUS_DEFAULT_MAX_OBJECTS,
  }];
}

export async function discoverOciFocusObjects(
  job: CloudIngestionJobContext,
  client: OciObjectStorageClient,
  withRetry: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>,
  tolerateErrors = false,
  withRateLimit?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  filterToJobWindow = false,
): Promise<{
  readonly objects: readonly OciFocusReportObject[];
  readonly apiCallCount: number;
  readonly errors: readonly string[];
}> {
  const discovered: OciFocusReportObject[] = [];
  const seen = new Set<string>();
  let apiCallCount = 0;
  const errors: string[] = [];

  for (const location of readOciFocusLocations(job)) {
    throwIfAborted(signal);
    let start: string | undefined;
    const locationStartCount = discovered.length;
    try {
      while (discovered.length - locationStartCount < location.maxObjects) {
        apiCallCount += 1;
        const operation = () => withRetry(() => client.listObjects({
          namespaceName: location.namespaceName,
          bucketName: location.bucketName,
          prefix: location.prefix,
          limit: Math.min(1000, location.maxObjects - (discovered.length - locationStartCount)),
          ...(start !== undefined ? { start } : {}),
        }), signal);
        const response = withRateLimit === undefined
          ? await operation()
          : await withRateLimit(operation, signal);

        for (const object of response.listObjects?.objects ?? []) {
          if (object.name === undefined || !isFocusObjectName(object.name)) continue;
          if (filterToJobWindow && !isOciFocusObjectInWindow(object.name, job)) continue;
          const identity = `${location.namespaceName}/${location.bucketName}/${object.name}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
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
      if (signal?.aborted === true) throw error;
      if (!tolerateErrors) throw error;
      errors.push(`${location.namespaceName}/${location.bucketName}: ${safeOciProviderError(error)}`);
    }
  }

  return { objects: discovered, apiCallCount, errors };
}

/**
 * Returns whether an object can contain rows for a billing job. OCI-managed
 * Cost Reports use `FOCUS Reports/YYYY/MM/DD/...`; objects with no recognized
 * date remain eligible because custom exports do not have to follow that
 * layout and the CSV row filter is still authoritative.
 */
export function isOciFocusObjectInWindow(
  objectName: string,
  job: Pick<CloudIngestionJobContext, 'targetStart' | 'targetEnd'>,
): boolean {
  const objectDate = parseOciFocusObjectDate(objectName);
  if (objectDate === undefined) return true;
  const objectEnd = new Date(objectDate.getTime() + 24 * 60 * 60 * 1000);
  return objectEnd > job.targetStart && objectDate < job.targetEnd;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('OCI provider request cancelled');
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

function parseOciFocusObjectDate(objectName: string): Date | undefined {
  const match = /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/.exec(objectName);
  if (match === null) return undefined;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readMetadataField(
  item: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (item[key] !== undefined) return item[key];
  }
  return undefined;
}
