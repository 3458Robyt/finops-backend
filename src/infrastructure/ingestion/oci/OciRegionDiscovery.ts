import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { OciIdentityClient } from './OciSdkContracts.js';

export interface OciRegionDiscoveryDependencies {
  readonly createIdentityClient: (job: CloudIngestionJobContext) => OciIdentityClient;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
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
): Promise<OciRegionDiscoveryResult> {
  const fallback = job.connection.defaultRegion === undefined ? [] : [job.connection.defaultRegion];
  const client = dependencies.createIdentityClient(job);
  let apiCallCount = 0;

  try {
    apiCallCount += 1;
    const response = await dependencies.withRetry(() => client.listRegionSubscriptions({
      tenancyId: job.connection.rootExternalId,
    }));
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
    return {
      regionIds: fallback,
      apiCallCount,
      status: 'FALLBACK',
      warnings: [`No fue posible descubrir regiones OCI; se usará la región predeterminada. ${safeMessage(error)}`],
    };
  } finally {
    client.close?.();
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido';
}
