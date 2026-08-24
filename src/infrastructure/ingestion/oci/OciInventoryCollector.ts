import type {
  CloudIngestionJobContext,
  NormalizedCloudResource,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { optionalString, readObjectArray, requireString } from '../providerConfig.js';
import type { OciCompartmentDiscoveryResult } from './OciCompartmentDiscovery.js';
import type { OciRegionDiscoveryResult } from './OciRegionDiscovery.js';
import { readOciMetricDefinitions } from './OciMonitoringCollector.js';
import type { OciComputeClient, OciResourceSearchClient } from './OciSdkContracts.js';
import { collectOciResourceSearchInventory } from './OciResourceSearchCollector.js';
import { mergeOciTags, normalizeOciResourceStatus, ociInventorySourcePriority } from './OciResourceNormalizer.js';
import { safeErrorMessage } from '../../../application/observability/safeError.js';

export interface OciInventoryCollectionResult {
  readonly apiCallCount: number;
  readonly resources: readonly NormalizedCloudResource[];
  readonly warnings: readonly string[];
  readonly source: string;
  readonly coverage: Readonly<Record<string, unknown>>;
}

export interface OciInventoryDependencies {
  readonly createComputeClient: (job: CloudIngestionJobContext) => OciComputeClient;
  readonly createResourceSearchClient?: (job: CloudIngestionJobContext) => OciResourceSearchClient;
  readonly discoverCompartments: (
    job: CloudIngestionJobContext,
  ) => Promise<OciCompartmentDiscoveryResult>;
  readonly discoverRegions?: (
    job: CloudIngestionJobContext,
  ) => Promise<OciRegionDiscoveryResult>;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly withRateLimit?: <T>(job: CloudIngestionJobContext, api: 'resourceSearch' | 'compute', operation: () => Promise<T>) => Promise<T>;
}

export async function collectOciInventory(
  job: CloudIngestionJobContext,
  dependencies: OciInventoryDependencies,
): Promise<OciInventoryCollectionResult> {
  const explicit = readExplicitResources(job);
  const inferred = readMetricResources(job);
  let sdkResources: readonly NormalizedCloudResource[] = [];
  let searchResources: readonly NormalizedCloudResource[] = [];
  let resourceSearchStatus: 'COMPLETE' | 'FAILED' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED';
  let resourceSearchFilteredCount = 0;
  let resourceSearchTypes: readonly string[] = [];
  let apiCallCount = 0;
  const warnings: string[] = [];

  if (dependencies.createResourceSearchClient !== undefined) {
    try {
      const searchOperation = () => collectOciResourceSearchInventory(job, {
        createClient: dependencies.createResourceSearchClient!,
        withRetry: dependencies.withRetry,
      });
      const search = dependencies.withRateLimit === undefined
        ? await searchOperation()
        : await dependencies.withRateLimit(job, 'resourceSearch', searchOperation);
      searchResources = search.resources;
      resourceSearchStatus = 'COMPLETE';
      resourceSearchFilteredCount = search.filteredResourceCount;
      resourceSearchTypes = search.resourceTypes;
      apiCallCount += search.apiCallCount;
      warnings.push(...search.warnings);
    } catch (error) {
      resourceSearchStatus = 'FAILED';
      warnings.push(`OCI Resource Search skipped: ${safeErrorMessage(error)}`);
    }
  }
  let coverage: Readonly<Record<string, unknown>> = {
    inventoryCompartmentDiscovery: 'NOT_ATTEMPTED',
  };

  try {
    const inventory = await collectComputeInventory(job, dependencies);
    sdkResources = inventory.resources;
    apiCallCount += inventory.apiCallCount;
    coverage = inventory.coverage;
    warnings.push(...inventory.warnings);
  } catch (error) {
    warnings.push(`OCI inventory SDK skipped: ${safeErrorMessage(error)}`);
    coverage = { inventoryCompartmentDiscovery: 'FAILED' };
  }

  const resources = mergeInventoryResources([...inferred, ...searchResources, ...sdkResources, ...explicit]);
  if (resources.length === 0) {
    warnings.push('No OCI inventory resources found from Resource Search, Compute SDK, metadata or metric definitions.');
  }

  return {
    apiCallCount,
    resources,
    warnings,
    source: searchResources.length > 0
      ? 'oci_resource_search_with_compute_and_metadata'
      : sdkResources.length > 0 ? 'oci_compute_sdk_with_metadata_fallback' : 'metadata_and_metric_definitions',
    coverage: {
      ...coverage,
      configuredResourceCount: explicit.length,
      metricDefinitionResourceCount: inferred.length,
      resourceSearchStatus,
      resourceSearchTypes,
      resourceSearchFilteredCount,
      resourceSearchResourceCount: searchResources.length,
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
  readonly warnings: readonly string[];
}> {
  const discovery = await dependencies.discoverCompartments(job);
  const regions = dependencies.discoverRegions === undefined
    ? { regionIds: job.connection.defaultRegion === undefined ? [] : [job.connection.defaultRegion], apiCallCount: 0, status: 'FALLBACK' as const, warnings: [] }
    : await dependencies.discoverRegions(job);
  const resources: NormalizedCloudResource[] = [];
  let apiCallCount = discovery.apiCallCount + regions.apiCallCount;
  const warnings = [...regions.warnings];

  for (const regionId of regions.regionIds) {
    const regionalJob = withRegion(job, regionId);
    const client = dependencies.createComputeClient(regionalJob);
    try {
      for (const compartmentId of discovery.compartmentIds) {
        let page: string | undefined;
        do {
          apiCallCount += 1;
          const request = () => dependencies.withRetry(() => client.listInstances({
            compartmentId,
            ...(page !== undefined ? { page } : {}),
          }));
          const response = dependencies.withRateLimit === undefined
            ? await request()
            : await dependencies.withRateLimit(regionalJob, 'compute', request);
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
              // OCI Compute may return the short region key (for example `phx`)
              // even though the request was made against the canonical region
              // name (`us-phoenix-1`). Persist the region used by the discovery
              // loop so inventory, metrics and costs can be joined reliably.
              regionId,
              status: normalizeOciResourceStatus(instance.lifecycleState),
              tags: mergeOciTags(instance.freeformTags, instance.definedTags),
              rawResource: {
                source: 'OCI_COMPUTE_SDK',
                normalizerVersion: 'oci-compute-v1',
                compartmentId,
                regionId,
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
  }

  return {
    apiCallCount,
    resources,
    coverage: {
      inventoryCompartmentDiscovery: discovery.status,
      configuredCompartmentCount: discovery.configuredCompartmentCount,
      discoveredCompartmentCount: discovery.discoveredCompartmentCount,
      compartmentCount: discovery.compartmentIds.length,
      includedCompartmentCount: discovery.includedCompartmentCount,
      excludedCompartmentCount: discovery.excludedCompartmentCount,
      compartmentDiscoveryApiCalls: discovery.apiCallCount,
      regionDiscoveryStatus: regions.status,
      regions: regions.regionIds,
    },
    warnings,
  };
}

function withRegion(job: CloudIngestionJobContext, regionId: string): CloudIngestionJobContext {
  return {
    ...job,
    requestContext: {
      ...(job.requestContext ?? {}),
      regionId,
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
      status: normalizeOciResourceStatus(optionalString(item['status'])),
      rawResource: { source: 'OCI_INVENTORY_METADATA', normalizerVersion: 'oci-metadata-v1', ...item },
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
    ...((definition.regionId ?? job.connection.defaultRegion) !== undefined
      ? { regionId: definition.regionId ?? job.connection.defaultRegion }
      : {}),
    status: 'UNKNOWN',
    rawResource: {
      source: 'OCI_METRIC_DEFINITION',
      normalizerVersion: 'oci-metric-definition-v1',
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
    if (previous === undefined || ociInventorySourcePriority(resource) > ociInventorySourcePriority(previous)) {
      byId.set(resource.externalResourceId, resource);
    }
  }
  return [...byId.values()];
}
