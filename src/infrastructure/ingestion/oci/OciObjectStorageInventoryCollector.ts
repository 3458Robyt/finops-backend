import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { OciObjectStorageClient } from './OciSdkContracts.js';
import { mergeOciTags } from './OciResourceNormalizer.js';

export interface OciObjectStorageInventoryDependencies {
  readonly createClient: (job: CloudIngestionJobContext) => OciObjectStorageClient;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly withRateLimit?: <T>(
    job: CloudIngestionJobContext,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

export interface OciObjectStorageInventoryResult {
  readonly apiCallCount: number;
  readonly resources: readonly NormalizedCloudResource[];
  readonly warnings: readonly string[];
}

export async function collectOciObjectStorageInventory(
  job: CloudIngestionJobContext,
  namespaceName: string | undefined,
  compartmentIds: readonly string[],
  regionIds: readonly string[],
  dependencies: OciObjectStorageInventoryDependencies,
): Promise<OciObjectStorageInventoryResult> {
  if (namespaceName === undefined || compartmentIds.length === 0 || regionIds.length === 0) {
    return { apiCallCount: 0, resources: [], warnings: [] };
  }

  const resources: NormalizedCloudResource[] = [];
  const warnings: string[] = [];
  let apiCallCount = 0;

  for (const regionId of regionIds) {
    const regionalJob = withRegion(job, regionId);
    const client = dependencies.createClient(regionalJob);
    try {
      for (const compartmentId of compartmentIds) {
        let page: string | undefined;
        do {
          apiCallCount += 1;
          const request = () => dependencies.withRetry(() => client.listBuckets({
            namespaceName,
            compartmentId,
            limit: 1000,
            ...(page === undefined ? {} : { page }),
          }));
          const response = dependencies.withRateLimit === undefined
            ? await request()
            : await dependencies.withRateLimit(regionalJob, request);
          for (const bucket of response.items ?? []) {
            const name = bucket.name?.trim();
            if (name === undefined || name === '') {
              warnings.push(`OCI Object Storage omitió un bucket sin nombre en ${regionId}/${compartmentId}.`);
              continue;
            }
            const timeCreated = normalizeTimestamp(bucket.timeCreated);
            resources.push({
              tenantId: job.tenantId,
              cloudConnectionId: job.cloudConnectionId,
              provider: 'OCI',
              externalResourceId: `${namespaceName}/${name}`,
              name,
              resourceType: 'OBJECT_STORAGE_BUCKET',
              serviceName: 'Oracle Object Storage',
              regionId,
              status: 'ACTIVE',
              tags: mergeOciTags(bucket.freeformTags, bucket.definedTags),
              rawResource: {
                source: 'OCI_OBJECT_STORAGE_SDK',
                normalizerVersion: 'oci-object-storage-v1',
                namespaceName,
                bucketName: name,
                aliases: [name],
                compartmentId,
                regionId,
                ...(timeCreated === undefined ? {} : { timeCreated }),
              },
              ...(timeCreated === undefined ? {} : { firstSeenAt: new Date(timeCreated) }),
            });
          }
          page = response.opcNextPage;
        } while (page !== undefined && page !== '');
      }
    } catch (error) {
      warnings.push(`OCI Object Storage inventory skipped for ${regionId}: ${safeMessage(error)}`);
    } finally {
      client.close?.();
    }
  }

  return { apiCallCount, resources, warnings };
}

function withRegion(job: CloudIngestionJobContext, regionId: string): CloudIngestionJobContext {
  return {
    ...job,
    requestContext: { ...(job.requestContext ?? {}), regionId },
  };
}

function normalizeTimestamp(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido';
}
