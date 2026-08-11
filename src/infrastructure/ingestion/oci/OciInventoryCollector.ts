import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { optionalString, readObjectArray, requireString } from '../providerConfig.js';
import type { OciCompartmentDiscoveryResult } from './OciCompartmentDiscovery.js';
import { readOciMetricDefinitions } from './OciMonitoringCollector.js';
import type { OciComputeClient } from './OciSdkContracts.js';

export interface OciInventoryCollectionResult {
  readonly apiCallCount: number;
  readonly resources: readonly NormalizedCloudResource[];
  readonly warnings: readonly string[];
  readonly source: string;
  readonly coverage: Readonly<Record<string, unknown>>;
}

export interface OciInventoryDependencies {
  readonly createComputeClient: (job: CloudIngestionJobContext) => OciComputeClient;
  readonly discoverCompartments: (
    job: CloudIngestionJobContext,
  ) => Promise<OciCompartmentDiscoveryResult>;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function collectOciInventory(
  job: CloudIngestionJobContext,
  dependencies: OciInventoryDependencies,
): Promise<OciInventoryCollectionResult> {
  const explicit = readExplicitResources(job);
  const inferred = readMetricResources(job);
  let sdkResources: readonly NormalizedCloudResource[] = [];
  let apiCallCount = 0;
  const warnings: string[] = [];
  let coverage: Readonly<Record<string, unknown>> = {
    inventoryCompartmentDiscovery: 'NOT_ATTEMPTED',
  };

  try {
    const inventory = await collectComputeInventory(job, dependencies);
    sdkResources = inventory.resources;
    apiCallCount = inventory.apiCallCount;
    coverage = inventory.coverage;
  } catch (error) {
    warnings.push(`OCI inventory SDK skipped: ${error instanceof Error ? error.message : String(error)}`);
    coverage = { inventoryCompartmentDiscovery: 'FAILED' };
  }

  const resources = mergeInventoryResources([...inferred, ...explicit, ...sdkResources]);
  if (resources.length === 0) {
    warnings.push('No OCI inventory resources found from Compute SDK, metadata or metric definitions.');
  }

  return {
    apiCallCount,
    resources,
    warnings,
    source: sdkResources.length > 0
      ? 'oci_compute_sdk_with_metadata_fallback'
      : 'metadata_and_metric_definitions',
    coverage: {
      ...coverage,
      configuredResourceCount: explicit.length,
      metricDefinitionResourceCount: inferred.length,
      sdkResourceCount: sdkResources.length,
      mergedResourceCount: resources.length,
    },
  };
}

async function collectComputeInventory(
  job: CloudIngestionJobContext,
  dependencies: OciInventoryDependencies,
): Promise<{
  readonly apiCallCount: number;
  readonly resources: readonly NormalizedCloudResource[];
  readonly coverage: Readonly<Record<string, unknown>>;
}> {
  const discovery = await dependencies.discoverCompartments(job);
  const client = dependencies.createComputeClient(job);
  const resources: NormalizedCloudResource[] = [];
  let apiCallCount = discovery.apiCallCount;

  try {
    for (const compartmentId of discovery.compartmentIds) {
      let page: string | undefined;
      do {
        apiCallCount += 1;
        const response = await dependencies.withRetry(() => client.listInstances({
          compartmentId,
          ...(page !== undefined ? { page } : {}),
        }));
        for (const instance of response.items ?? []) {
          if (instance.id === undefined) continue;
          resources.push({
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            provider: 'OCI',
            externalResourceId: instance.id,
            name: instance.displayName ?? instance.id,
            resourceType: 'COMPUTE_INSTANCE',
            serviceName: 'Oracle Compute',
            ...(job.connection.defaultRegion !== undefined
              ? { regionId: job.connection.defaultRegion }
              : {}),
            status: normalizeResourceStatus(instance.lifecycleState),
            tags: mergeTags(instance.freeformTags, instance.definedTags),
            rawResource: {
              source: 'OCI_COMPUTE_SDK',
              compartmentId,
              shape: instance.shape,
              lifecycleState: instance.lifecycleState,
            },
          });
        }
        page = response.opcNextPage;
      } while (page !== undefined);
    }
  } finally {
    client.close?.();
  }

  return {
    apiCallCount,
    resources,
    coverage: {
      inventoryCompartmentDiscovery: discovery.status,
      configuredCompartmentCount: discovery.configuredCompartmentCount,
      discoveredCompartmentCount: discovery.discoveredCompartmentCount,
      compartmentCount: discovery.compartmentIds.length,
      compartmentDiscoveryApiCalls: discovery.apiCallCount,
    },
  };
}

function readExplicitResources(job: CloudIngestionJobContext): readonly NormalizedCloudResource[] {
  return readObjectArray(job.connection.metadata, 'ociInventoryResources').map((item) => {
    const externalResourceId = requireString(item['externalResourceId'], 'ociInventoryResources.externalResourceId');
    const regionId = optionalString(item['regionId'])
      ?? optionalString(item['region'])
      ?? job.connection.defaultRegion;
    return {
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      provider: 'OCI',
      externalResourceId,
      name: optionalString(item['name']) ?? optionalString(item['displayName']) ?? externalResourceId,
      resourceType: optionalString(item['resourceType']) ?? 'COMPUTE_INSTANCE',
      serviceName: optionalString(item['serviceName']) ?? 'Oracle Compute',
      ...(regionId !== undefined ? { regionId } : {}),
      status: normalizeResourceStatus(optionalString(item['status'])),
      rawResource: { source: 'OCI_INVENTORY_METADATA', ...item },
    };
  });
}

function readMetricResources(job: CloudIngestionJobContext): readonly NormalizedCloudResource[] {
  return readOciMetricDefinitions(job).map((definition) => ({
    tenantId: job.tenantId,
    cloudConnectionId: job.cloudConnectionId,
    provider: 'OCI',
    externalResourceId: definition.resourceId,
    name: definition.resourceId,
    resourceType: 'COMPUTE_INSTANCE',
    serviceName: 'Oracle Compute',
    ...(job.connection.defaultRegion !== undefined ? { regionId: job.connection.defaultRegion } : {}),
    status: 'UNKNOWN',
    rawResource: {
      source: 'OCI_METRIC_DEFINITION',
      namespace: definition.namespace,
      compartmentId: definition.compartmentId,
      metricName: definition.metricName,
    },
  }));
}

function mergeInventoryResources(
  resources: readonly NormalizedCloudResource[],
): readonly NormalizedCloudResource[] {
  const byId = new Map<string, NormalizedCloudResource>();
  for (const resource of resources) {
    const previous = byId.get(resource.externalResourceId);
    if (previous === undefined || previous.rawResource?.['source'] === 'OCI_METRIC_DEFINITION') {
      byId.set(resource.externalResourceId, resource);
    }
  }
  return [...byId.values()];
}

function normalizeResourceStatus(status: string | undefined): NormalizedCloudResource['status'] {
  const normalized = status?.toUpperCase();
  if (normalized === 'ACTIVE' || normalized === 'RUNNING' || normalized === 'AVAILABLE') return 'ACTIVE';
  if (normalized === 'STOPPED' || normalized === 'STOPPING') return 'STOPPED';
  if (normalized === 'TERMINATED' || normalized === 'DELETED') return 'TERMINATED';
  return 'UNKNOWN';
}

function mergeTags(
  freeform: Readonly<Record<string, unknown>> | undefined,
  defined: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return { ...(freeform ?? {}), ...(defined !== undefined ? { definedTags: defined } : {}) };
}
