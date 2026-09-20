import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { OciIdentityClient } from './OciSdkContracts.js';

export interface OciRegionDiscoveryDependencies {
  readonly createIdentityClient: (job: CloudIngestionJobContext, signal?: AbortSignal) => OciIdentityClient;
  readonly withRetry: <T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

export interface OciRegionDiscoveryResult {
  readonly regionIds: readonly string[];
  readonly apiCallCount: number;
  readonly status: 'COMPLETE' | 'FALLBACK';
  readonly warnings: readonly string[];
}

/** Discovers subscribed OCI regions without exposing credentials or raw SDK objects. */
export async function discoverOciRegions(
  job: CloudIngestionJobContext,
  dependencies: OciRegionDiscoveryDependencies,
  signal?: AbortSignal,
): Promise<OciRegionDiscoveryResult> {
  const fallback = job.connection.defaultRegion === undefined ? [] : [job.connection.defaultRegion];
  let apiCallCount = 0;

  try {
    throwIfAborted(signal);
    apiCallCount += 1;
    const response = await dependencies.withRetry(async (attemptSignal) => {
      const client = dependencies.createIdentityClient(job, attemptSignal);
      try {
        return await client.listRegionSubscriptions({ tenancyId: job.connection.rootExternalId });
      } finally {
        client.close?.();
      }
    }, signal);
    const discovered = (response.items ?? []).flatMap((item) => {
      const id = item.regionName ?? item.regionKey;
      return typeof id === 'string' && id.trim() !== '' && item.status?.toUpperCase() !== 'INACTIVE'
        ? [id.trim()]
        : [];
    });
    const regionIds = [...new Set([...fallback, ...discovered])];
    return {
      regionIds,
      apiCallCount,
      status: regionIds.length > 0 ? 'COMPLETE' : 'FALLBACK',
      warnings: regionIds.length > 0 ? [] : ['OCI no devolvió regiones suscritas y no existe región predeterminada.'],
    };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return {
      regionIds: fallback,
      apiCallCount,
      status: 'FALLBACK',
      warnings: [`No fue posible descubrir regiones OCI; se usará la región predeterminada. ${safeMessage(error)}`],
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('OCI inventory operation cancelled');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido';
}
