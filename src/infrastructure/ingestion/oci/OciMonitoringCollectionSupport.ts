import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { optionalString } from '../providerConfig.js';
import type { OciMonitoringClient } from './OciSdkContracts.js';

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function getOrCreateRegionalClient(
  job: CloudIngestionJobContext,
  regionId: string,
  createClient: (job: CloudIngestionJobContext) => OciMonitoringClient,
  clientsByRegion: Map<string, OciMonitoringClient>,
): OciMonitoringClient {
  const existing = clientsByRegion.get(regionId);
  if (existing !== undefined) return existing;
  const created = createClient(job);
  clientsByRegion.set(regionId, created);
  return created;
}

export function regionKey(job: Pick<CloudIngestionJobContext, 'connection' | 'requestContext'>): string {
  const requestRegion = optionalString(job.requestContext?.['regionId']);
  return requestRegion ?? job.connection.defaultRegion ?? 'default';
}
