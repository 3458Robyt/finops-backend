import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  FocusSourcePreviewResult,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { toAsyncByteChunks } from '../focusCsvIngestion.js';
import type {
  AwsCommandClient,
  AwsFocusExportLocation,
  AwsFocusExportObject,
  AwsGetObjectResponse,
  AwsListObjectsResponse,
} from './awsContracts.js';
import {
  isAwsFocusManifestName,
  isAwsFocusObjectName,
  readAwsFocusLocations,
  readAwsFocusObjects,
  safeAwsProviderError,
} from './awsConfiguration.js';

export interface AwsFocusObjectDiscoveryDependencies {
  readonly createS3Client: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsGetObjectResponse & AwsListObjectsResponse>;
}

export interface AwsFocusObjectDiscoveryResult {
  readonly objects: readonly AwsFocusExportObject[];
  readonly apiCallCount: number;
  readonly manifestsRead: number;
  readonly errors: readonly string[];
}

export async function discoverAwsFocusObjects(
  job: CloudIngestionJobContext,
  credentials: AwsCredentialIdentity,
  defaultRegion: string,
  dependencies: AwsFocusObjectDiscoveryDependencies,
  tolerateErrors = false,
): Promise<AwsFocusObjectDiscoveryResult> {
  const discovered: AwsFocusExportObject[] = [];
  let apiCallCount = 0;
  let manifestsRead = 0;
  const errors: string[] = [];

  for (const location of readAwsFocusLocations(job)) {
    const client = dependencies.createS3Client(location.region ?? defaultRegion, credentials);
    let continuationToken: string | undefined;
    const listed = new Map<string, AwsFocusExportObject>();
    const manifests: AwsListedObject[] = [];
    let listPages = 0;

    try {
      while (listed.size < location.maxObjects || manifests.length === 0) {
        apiCallCount += 1;
        listPages += 1;
        const response = await client.send(new ListObjectsV2Command({
          Bucket: location.bucket,
          Prefix: location.prefix,
          MaxKeys: Math.min(1000, Math.max(1, location.maxObjects - listed.size)),
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }));

        for (const object of response.Contents ?? []) {
          if (object.Key === undefined) continue;
          if (isAwsFocusManifestName(object.Key)) {
            manifests.push({
              key: object.Key,
              ...(object.LastModified !== undefined ? { lastModified: object.LastModified } : {}),
            });
            continue;
          }
          if (!isAwsFocusObjectName(object.Key)) continue;
          listed.set(object.Key, toAwsFocusObject(location, object.Key, object.Size, object.LastModified));
        }

        if (response.IsTruncated !== true || response.NextContinuationToken === undefined) break;
        if (listPages >= Math.ceil(location.maxObjects / 1000) + 10) {
          errors.push(`${location.bucket}/${location.prefix}: se alcanzó el límite de páginas de descubrimiento (${location.maxObjects} objetos).`);
          break;
        }
        continuationToken = response.NextContinuationToken;
      }

      const manifestLimit = Math.min(100, manifests.length);
      for (const manifest of manifests
        .sort((left, right) => (right.lastModified?.getTime() ?? 0) - (left.lastModified?.getTime() ?? 0))
        .slice(0, manifestLimit)) {
        apiCallCount += 1;
        try {
          const response = await client.send(new GetObjectCommand({ Bucket: location.bucket, Key: manifest.key }));
          const manifestText = await readObjectBodyText(response.Body);
          const references = extractAwsManifestObjectKeys(JSON.parse(manifestText));
          manifestsRead += 1;
          for (const reference of references) {
            const key = resolveAwsManifestObjectKey(reference, manifest.key, location);
            if (key === undefined || !isAwsFocusObjectName(key) || key === manifest.key) continue;
            if (!listed.has(key) && listed.size >= location.maxObjects) continue;
            listed.set(key, listed.get(key) ?? toAwsFocusObject(location, key));
          }
        } catch (error) {
          errors.push(`${location.bucket}/${manifest.key}: no se pudo leer el manifiesto FOCUS (${safeAwsProviderError(error)}).`);
        }
      }

      discovered.push(...[...listed.values()].slice(0, location.maxObjects));
    } catch (error) {
      if (!tolerateErrors) throw error;
      errors.push(`${location.bucket}/${location.prefix}: ${safeAwsProviderError(error)}`);
    } finally {
      client.destroy?.();
    }
  }

  return { objects: uniqueAwsFocusObjects(discovered), apiCallCount, manifestsRead, errors };
}

interface AwsListedObject {
  readonly key: string;
  readonly lastModified?: Date;
}

function toAwsFocusObject(
  location: { readonly bucket: string; readonly region?: string; readonly focusVersion: string },
  key: string,
  sizeBytes?: number,
  lastModified?: Date,
): AwsFocusExportObject {
  return {
    bucket: location.bucket,
    key,
    focusVersion: location.focusVersion,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
    ...(location.region !== undefined ? { region: location.region } : {}),
  };
}

async function readObjectBodyText(body: unknown): Promise<string> {
  let text = '';
  for await (const chunk of toAsyncByteChunks(body)) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.length > 2_000_000) throw new Error('AWS FOCUS manifest exceeds the 2 MB safety limit');
  }
  return text;
}

function extractAwsManifestObjectKeys(document: unknown): readonly string[] {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return [];
  const references = new Set<string>();
  const containerKeys = new Set(['reportkeys', 'files', 'datafiles', 'datafilekeys', 'exportfiles', 'reportfiles']);
  const referenceKeys = new Set(['filename', 'filepath', 'objectkey', 'key', 'path', 's3uri', 's3path', 'url']);

  const visit = (value: unknown, collectStrings: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, collectStrings);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      if (collectStrings && typeof value === 'string' && value.trim() !== '') references.add(value.trim());
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
      if (referenceKeys.has(normalizedKey) || containerKeys.has(normalizedKey)) visit(child, true);
    }
  };

  visit(document, false);
  return [...references];
}

function resolveAwsManifestObjectKey(
  reference: string,
  manifestKey: string,
  location: AwsFocusExportLocation,
): string | undefined {
  const trimmed = reference.trim();
  let candidate = trimmed;
  if (trimmed.toLowerCase().startsWith('s3://')) {
    const match = /^s3:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
    const bucket = match?.[1];
    const key = match?.[2];
    if (bucket === undefined || key === undefined || bucket.toLowerCase() !== location.bucket.toLowerCase()) return undefined;
    candidate = key;
  } else if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.hostname.toLowerCase().includes(location.bucket.toLowerCase())) return undefined;
      candidate = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
      return undefined;
    }
  }

  const manifestDirectory = manifestKey.includes('/')
    ? manifestKey.slice(0, manifestKey.lastIndexOf('/') + 1)
    : '';
  const normalizedCandidates = [candidate, `${manifestDirectory}${candidate}`, `${location.prefix.replace(/\/+$/, '')}/${candidate}`]
    .map((item) => decodeURIComponent(item).replace(/^\/+/, '').replace(/\/+/g, '/'));
  return normalizedCandidates.find((item) => (
    isAwsFocusObjectName(item)
    && (location.prefix === '' || item.startsWith(location.prefix))
  ));
}

export function uniqueAwsFocusObjects(objects: readonly AwsFocusExportObject[]): readonly AwsFocusExportObject[] {
  const byKey = new Map<string, AwsFocusExportObject>();
  for (const object of objects) {
    const key = `${object.bucket}/${object.key}`;
    if (!byKey.has(key)) byKey.set(key, object);
  }
  return [...byKey.values()];
}

export function buildAwsFocusPreviewResult(
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
