import type {
  CloudCapabilityValidation,
  CloudIngestionJobContext,
  FocusSourcePreviewResult,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  optionalString,
  readBoundedPositiveInteger,
  readObjectArray,
  requireString,
} from '../providerConfig.js';
import { safeOciProviderError, validateOciCall, withOciClient } from './OciCapabilityValidator.js';
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

  const validated = readValidatedFocusLocation(job);
  if (validated !== undefined) return [validated];

  // OCI stores Cost Reports in Oracle's managed "bling" namespace, with the
  // tenancy OCID as bucket and FOCUS Reports as the prefix. This avoids
  // requiring customers to copy a location already defined by OCI.
  if (job.connection.providerCode === 'oci' && job.connection.rootExternalId.trim().length > 0) {
    return [{
      namespaceName: 'bling',
      bucketName: job.connection.rootExternalId,
      prefix: 'FOCUS Reports/',
      focusVersion: '1.0',
      maxObjects: OCI_FOCUS_DEFAULT_MAX_OBJECTS,
    }];
  }

  return [];
}

export function usesManagedOciFocusLocation(job: CloudIngestionJobContext): boolean {
  if (job.connection.providerCode !== 'oci') return false;
  const isManaged = (namespaceName: string, bucketName: string, prefix: string) => (
    namespaceName === 'bling'
    && bucketName === job.connection.rootExternalId
    && prefix.replace(/\/+$/, '') === 'FOCUS Reports'
  );
  return readOciFocusLocations(job).some((location) => (
    isManaged(location.namespaceName, location.bucketName, location.prefix)
  )) || readOciFocusObjects(job).some((object) => (
    isManaged(object.namespaceName, object.bucketName, object.objectName.slice(0, object.objectName.indexOf('/') + 1))
  ));
}

export async function useManagedOciFocusHomeRegion(
  job: CloudIngestionJobContext,
  resolveHomeRegion: (job: CloudIngestionJobContext) => Promise<string>,
): Promise<CloudIngestionJobContext> {
  if (!usesManagedOciFocusLocation(job)) return job;
  return {
    ...job,
    requestContext: { ...job.requestContext, regionId: await resolveHomeRegion(job) },
  };
}

export function validateOciManagedFocusStorage(
  job: CloudIngestionJobContext,
  checkedAt: Date,
  prepareJob: (job: CloudIngestionJobContext) => Promise<CloudIngestionJobContext>,
  createClient: (job: CloudIngestionJobContext) => OciObjectStorageClient,
): Promise<CloudCapabilityValidation> {
  return validateOciCall('STORAGE', checkedAt, async () => {
    const focusJob = await prepareJob(job);
    const namespaceName = 'bling';
    const prefix = 'FOCUS Reports/';
    await withOciClient(createClient(focusJob), async (client) => client.listObjects({
      namespaceName,
      bucketName: job.connection.rootExternalId,
      prefix,
      limit: 1,
    }));
    const regionId = optionalString(focusJob.requestContext?.['regionId']);
    return {
      message: 'Lectura de los reportes FOCUS administrados por OCI disponible en la región principal de la tenancy.',
      metadata: { namespaceName, prefix, autoDetected: true, ...(regionId === undefined ? {} : { regionId }) },
    };
  });
}

export async function discoverOciFocusObjects(
  job: CloudIngestionJobContext,
  createClient: (signal?: AbortSignal) => OciObjectStorageClient,
  withRetry: <T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>,
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
        const operation = () => withRetry(async (attemptSignal) => {
          const client = createClient(attemptSignal);
          try {
            return await client.listObjects({
              namespaceName: location.namespaceName,
              bucketName: location.bucketName,
              prefix: location.prefix,
              limit: Math.min(1000, location.maxObjects - (discovered.length - locationStartCount)),
              ...(start !== undefined ? { start } : {}),
            });
          } finally {
            client.close?.();
          }
        }, signal);
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

export function emptyFocusReportWarning(job: CloudIngestionJobContext, foundObjectsOutsideRange: boolean): string {
  if (foundObjectsOutsideRange) return 'No se encontraron objetos de reporte FOCUS OCI para el periodo solicitado.';
  return readOciFocusLocations(job).length > 0
    ? 'No se encontraron objetos de reporte FOCUS OCI en la ubicación consultada. Verifica que los reportes estén habilitados y que la política permita leerlos; la ausencia de archivos no significa costo cero.'
    : 'No hay una ubicación de reportes FOCUS disponible. Configura el origen de facturación OCI o selecciona OCI Usage API.';
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

function readValidatedFocusLocation(
  job: CloudIngestionJobContext,
): OciFocusReportLocation | undefined {
  const validation = readRecord(job.connection.metadata?.['capabilityValidation']);
  const capabilities = validation?.['capabilities'];
  if (!Array.isArray(capabilities)) return undefined;
  const storage = capabilities.find((item) => (
    readRecord(item)?.['capability'] === 'STORAGE'
    && readRecord(item)?.['status'] === 'AVAILABLE'
  ));
  const storageMetadata = readRecord(readRecord(storage)?.['metadata']);
  const namespaceName = optionalString(storageMetadata?.['namespaceName']);
  const bucketName = optionalString(storageMetadata?.['bucketName']);
  const prefix = optionalString(storageMetadata?.['prefix']);
  if (namespaceName === undefined || bucketName === undefined || prefix === undefined) return undefined;
  return {
    namespaceName,
    bucketName,
    prefix,
    focusVersion: '1.0',
    maxObjects: OCI_FOCUS_DEFAULT_MAX_OBJECTS,
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
