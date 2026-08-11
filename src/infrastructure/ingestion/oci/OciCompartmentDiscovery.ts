import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, readStringArray } from '../providerConfig.js';
import { readOciMetricDefinitions } from './OciMonitoringCollector.js';
import type { OciIdentityClient } from './OciSdkContracts.js';

export interface OciCompartmentDiscoveryResult {
  readonly compartmentIds: readonly string[];
  readonly apiCallCount: number;
  readonly status: 'COMPLETE' | 'FALLBACK' | 'CONFIGURED_ONLY';
  readonly configuredCompartmentCount: number;
  readonly discoveredCompartmentCount: number;
}

export interface OciCompartmentDiscoveryDependencies {
  readonly createIdentityClient: (job: CloudIngestionJobContext) => OciIdentityClient;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function discoverOciInventoryCompartments(
  job: CloudIngestionJobContext,
  dependencies: OciCompartmentDiscoveryDependencies,
): Promise<OciCompartmentDiscoveryResult> {
  const configured = readConfiguredCompartments(job);
  const compartmentIds = new Set(configured);
  if (getCredential(job.connection.credentials, ['INVENTORY_READ', 'OPERATIONAL']) === undefined) {
    return buildResult(compartmentIds, 0, 'CONFIGURED_ONLY', configured.length, 0);
  }

  const client = dependencies.createIdentityClient(job);
  let apiCallCount = 0;
  let discoveredCompartmentCount = 0;
  let page: string | undefined;

  try {
    do {
      apiCallCount += 1;
      const response = await dependencies.withRetry(() => client.listCompartments({
        compartmentId: job.connection.rootExternalId,
        compartmentIdInSubtree: true,
        accessLevel: 'ACCESSIBLE',
        lifecycleState: 'ACTIVE',
        limit: 1000,
        ...(page !== undefined ? { page } : {}),
      }));
      for (const compartment of response.items ?? []) {
        if (compartment.id !== undefined && compartment.lifecycleState?.toUpperCase() === 'ACTIVE') {
          compartmentIds.add(compartment.id);
          discoveredCompartmentCount += 1;
        }
      }
      page = response.opcNextPage;
    } while (page !== undefined);
  } catch {
    return buildResult(
      compartmentIds,
      apiCallCount,
      'FALLBACK',
      configured.length,
      discoveredCompartmentCount,
    );
  } finally {
    client.close?.();
  }

  return buildResult(
    compartmentIds,
    apiCallCount,
    'COMPLETE',
    configured.length,
    discoveredCompartmentCount,
  );
}

function readConfiguredCompartments(job: CloudIngestionJobContext): readonly string[] {
  const configured = readStringArray(job.connection.metadata?.['ociInventoryCompartments']);
  const metricCompartments = readOciMetricDefinitions(job).map((item) => item.compartmentId);
  return [...new Set([...configured, ...metricCompartments, job.connection.rootExternalId])];
}

function buildResult(
  compartmentIds: ReadonlySet<string>,
  apiCallCount: number,
  status: OciCompartmentDiscoveryResult['status'],
  configuredCompartmentCount: number,
  discoveredCompartmentCount: number,
): OciCompartmentDiscoveryResult {
  return {
    compartmentIds: [...compartmentIds],
    apiCallCount,
    status,
    configuredCompartmentCount,
    discoveredCompartmentCount,
  };
}
