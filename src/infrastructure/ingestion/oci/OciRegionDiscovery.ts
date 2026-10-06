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
    const response = await listRegionSubscriptions(job, dependencies, signal);
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

/** Cost Reports live in the tenancy's home region; never substitute a user's default region. */
export async function discoverOciHomeRegion(
  job: CloudIngestionJobContext,
  dependencies: OciRegionDiscoveryDependencies,
  signal?: AbortSignal,
): Promise<string> {
  const response = await listRegionSubscriptions(job, dependencies, signal);
  const homeRegions = (response.items ?? []).filter((item) => (
    item.isHomeRegion === true && item.status?.toUpperCase() !== 'INACTIVE'
  ));
  if (homeRegions.length !== 1) {
    throw new Error('OCI no devolvió una única región principal de la tenancy; no se consultará FOCUS en una región supuesta.');
  }
  const homeRegionId = homeRegions[0]?.regionName?.trim();
  if (homeRegionId === undefined || homeRegionId === '') {
    throw new Error('OCI no devolvió el identificador de la región principal de la tenancy.');
  }
  return homeRegionId;
}

async function listRegionSubscriptions(
  job: CloudIngestionJobContext,
  dependencies: OciRegionDiscoveryDependencies,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  return dependencies.withRetry(async (attemptSignal) => {
    const client = dependencies.createIdentityClient(job, attemptSignal);
    try {
      return await client.listRegionSubscriptions({ tenancyId: job.connection.rootExternalId });
    } finally {
      client.close?.();
    }
  }, signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('OCI inventory operation cancelled');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido';
}
