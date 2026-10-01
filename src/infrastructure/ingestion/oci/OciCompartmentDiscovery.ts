import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, readStringArray } from '../providerConfig.js';
import { readOciMetricDefinitions } from './OciMonitoringCollector.js';
import type { OciIdentityClient } from './OciSdkContracts.js';
import { filterOciCompartmentIds, readOciCompartmentFilter } from './OciCompartmentFilter.js';

export interface OciCompartmentDiscoveryResult {
  readonly compartmentIds: readonly string[];
  readonly apiCallCount: number;
  readonly status: 'COMPLETE' | 'FALLBACK' | 'CONFIGURED_ONLY';
  readonly configuredCompartmentCount: number;
  readonly discoveredCompartmentCount: number;
  readonly includedCompartmentCount: number;
  readonly excludedCompartmentCount: number;
}

export interface OciCompartmentDiscoveryDependencies {
  readonly createIdentityClient: (job: CloudIngestionJobContext, signal?: AbortSignal) => OciIdentityClient;
  readonly withRetry: <T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

export async function discoverOciInventoryCompartments(
  job: CloudIngestionJobContext,
  dependencies: OciCompartmentDiscoveryDependencies,
  signal?: AbortSignal,
): Promise<OciCompartmentDiscoveryResult> {
  const configured = readConfiguredCompartments(job);
  const compartmentIds = new Set(configured);
  if (getCredential(job.connection.credentials, ['INVENTORY_READ', 'OPERATIONAL']) === undefined) {
    return buildResult(job, compartmentIds, 0, 'CONFIGURED_ONLY', configured.length, 0);
  }

  let apiCallCount = 0;
  let discoveredCompartmentCount = 0;
  let page: string | undefined;

  try {
    do {
      throwIfAborted(signal);
      apiCallCount += 1;
      const response = await dependencies.withRetry(async (attemptSignal) => {
        const client = dependencies.createIdentityClient(job, attemptSignal);
        try {
          return await client.listCompartments({
            compartmentId: job.connection.rootExternalId,
            compartmentIdInSubtree: true,
            accessLevel: 'ACCESSIBLE',
            lifecycleState: 'ACTIVE',
            limit: 1000,
            ...(page !== undefined ? { page } : {}),
          });
        } finally {
          client.close?.();
        }
      }, signal);
      for (const compartment of response.items ?? []) {
        if (compartment.id !== undefined && compartment.lifecycleState?.toUpperCase() === 'ACTIVE') {
          compartmentIds.add(compartment.id);
          discoveredCompartmentCount += 1;
        }
      }
      page = response.opcNextPage;
    } while (page !== undefined);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return buildResult(
      job,
      compartmentIds,
      apiCallCount,
      'FALLBACK',
      configured.length,
      discoveredCompartmentCount,
    );
  }

  return buildResult(
    job,
    compartmentIds,
    apiCallCount,
    'COMPLETE',
    configured.length,
    discoveredCompartmentCount,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('OCI inventory operation cancelled');
}

function readConfiguredCompartments(job: CloudIngestionJobContext): readonly string[] {
  const configured = readStringArray(job.connection.metadata?.['ociInventoryCompartments']);
  const metricCompartments = readOciMetricDefinitions(job).map((item) => item.compartmentId);
  return [...new Set([...configured, ...metricCompartments, job.connection.rootExternalId])];
}

function buildResult(
  jobForFilter: CloudIngestionJobContext,
  compartmentIds: ReadonlySet<string>,
  apiCallCount: number,
  status: OciCompartmentDiscoveryResult['status'],
  configuredCompartmentCount: number,
  discoveredCompartmentCount: number,
): OciCompartmentDiscoveryResult {
  const filter = readOciCompartmentFilter(jobForFilter);
  return {
    compartmentIds: filterOciCompartmentIds(compartmentIds, filter),
    apiCallCount,
    status,
    configuredCompartmentCount,
    discoveredCompartmentCount,
    includedCompartmentCount: filter.includeIds.size,
    excludedCompartmentCount: filter.excludeIds.size,
  };
}
