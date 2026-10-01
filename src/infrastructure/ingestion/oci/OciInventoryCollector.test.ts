import { describe, expect, test, vi } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { discoverOciInventoryCompartments } from './OciCompartmentDiscovery.js';
import { collectOciInventory } from './OciInventoryCollector.js';

describe('OCI inventory modules', () => {
  test('uses configured and metric compartments without constructing Identity when no credential exists', async () => {
    const createIdentityClient = vi.fn();
    const result = await discoverOciInventoryCompartments(buildJob({
      metadata: {
        ociInventoryCompartments: ['configured-1'],
        ociMetricDefinitions: [{
          compartmentId: 'metric-1',
          metricName: 'CpuUtilization',
          resourceId: 'instance-1',
        }],
      },
    }), {
      createIdentityClient,
      withRetry: (operation) => operation(),
    });

    expect(createIdentityClient).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'CONFIGURED_ONLY', apiCallCount: 0 });
    expect(result.compartmentIds).toEqual(['configured-1', 'metric-1', 'tenancy-1']);
  });

  test('reports fallback scope and closes Identity when compartment discovery is denied', async () => {
    const close = vi.fn();
    const result = await discoverOciInventoryCompartments(buildJob({
      credentials: [{ purpose: 'INVENTORY_READ', payload: {} }],
    }), {
      createIdentityClient: () => ({
        close,
        getUser: async () => ({}),
        listCompartments: async () => { throw new Error('403 Forbidden'); },
      }),
      withRetry: (operation) => operation(),
    });

    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'FALLBACK', apiCallCount: 1 });
    expect(result.compartmentIds).toEqual(['tenancy-1']);
  });

  test('applies explicit compartment include and exclude filters after discovery', async () => {
    const result = await discoverOciInventoryCompartments(buildJob({
      credentials: [{ purpose: 'INVENTORY_READ', payload: {} }],
      metadata: {
        ociInventoryIncludeCompartments: ['compartment-1'],
        ociInventoryExcludeCompartments: ['compartment-2'],
      },
    }), {
      createIdentityClient: () => ({
        getUser: async () => ({}),
        listCompartments: async () => ({ items: [
          { id: 'compartment-1', lifecycleState: 'ACTIVE' },
          { id: 'compartment-2', lifecycleState: 'ACTIVE' },
        ] }),
      }),
      withRetry: (operation) => operation(),
    });

    expect(result.compartmentIds).toEqual(['compartment-1']);
    expect(result).toMatchObject({ includedCompartmentCount: 1, excludedCompartmentCount: 1 });
  });

  test('keeps explicit inventory metadata over inferred and SDK duplicates', async () => {
    const close = vi.fn();
    const result = await collectOciInventory(buildJob({
      metadata: {
        ociInventoryResources: [{
          externalResourceId: 'instance-1',
          name: 'Nombre gobernado',
          status: 'STOPPED',
        }],
        ociMetricDefinitions: [{
          compartmentId: 'tenancy-1',
          metricName: 'CpuUtilization',
          resourceId: 'instance-1',
        }],
      },
    }), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'],
        apiCallCount: 0,
        status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1,
        discoveredCompartmentCount: 0,
      }),
      createComputeClient: () => ({
        close,
        listInstances: async () => ({
          items: [
            { id: 'instance-1', displayName: 'Nombre SDK', lifecycleState: 'RUNNING' },
            { id: 'instance-2', displayName: 'Solo SDK', lifecycleState: 'RUNNING' },
          ],
        }),
      }),
      withRetry: (operation) => operation(),
    });

    expect(close).toHaveBeenCalledOnce();
    expect(result.resources).toEqual([
      expect.objectContaining({ externalResourceId: 'instance-1', name: 'Nombre gobernado', status: 'STOPPED' }),
      expect.objectContaining({ externalResourceId: 'instance-2', name: 'Solo SDK', status: 'ACTIVE' }),
    ]);
    expect(result.coverage).toMatchObject({ sdkResourceCount: 2, mergedResourceCount: 2 });
  });

  test('classifies metric-definition resources from OCID and excludes tenancy-level aggregates', async () => {
    const result = await collectOciInventory(buildJob({
      metadata: {
        ociMetricDefinitions: [
          { compartmentId: 'tenancy-1', namespace: 'oci_blockstore', metricName: 'VolumeGuaranteedIOPS', resourceId: 'ocid1.volume.oc1..exampleid0037' },
          { compartmentId: 'tenancy-1', namespace: 'oci_blockstore', metricName: 'VolumeGuaranteedThroughput', resourceId: 'ocid1.bootvolume.oc1..exampleid0002' },
          { compartmentId: 'tenancy-1', namespace: 'oci_computeagent', metricName: 'CpuUtilization', resourceId: 'ocid1.instance.oc1..exampleid0017' },
          { compartmentId: 'tenancy-1', namespace: 'oci_unknown', metricName: 'UnknownMetric', resourceId: 'ocid1.unknownresource.oc1..exampleid0028' },
          { compartmentId: 'tenancy-1', namespace: 'oci_computeagent', metricName: 'CpuUtilization' },
        ],
      },
    }), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'], apiCallCount: 0, status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1, discoveredCompartmentCount: 0,
      }),
      createComputeClient: () => ({ listInstances: async () => ({ items: [] }) }),
      withRetry: (operation) => operation(),
    });

    expect(result.resources).toHaveLength(4);
    expect(result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalResourceId: 'ocid1.volume.oc1..exampleid0037', resourceType: 'BLOCK_VOLUME', serviceName: 'Oracle Block Volume' }),
      expect.objectContaining({ externalResourceId: 'ocid1.bootvolume.oc1..exampleid0002', resourceType: 'BOOT_VOLUME', serviceName: 'Oracle Block Volume' }),
      expect.objectContaining({ externalResourceId: 'ocid1.instance.oc1..exampleid0017', resourceType: 'COMPUTE_INSTANCE', serviceName: 'Oracle Compute' }),
      expect.objectContaining({ externalResourceId: 'ocid1.unknownresource.oc1..exampleid0028', resourceType: 'OCI_RESOURCE', serviceName: 'Oracle Cloud Infrastructure' }),
    ]));
    expect(result.resources.some((resource) => resource.externalResourceId === 'tenancy-1')).toBe(false);
  });

  test('persists the canonical discovered region instead of OCI short region keys', async () => {
    const result = await collectOciInventory(buildJob({ defaultRegion: 'us-phoenix-1' }), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'],
        apiCallCount: 0,
        status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1,
        discoveredCompartmentCount: 0,
      }),
      discoverRegions: async () => ({
        regionIds: ['us-phoenix-1'],
        apiCallCount: 1,
        status: 'COMPLETE',
        warnings: [],
      }),
      createComputeClient: () => ({
        listInstances: async () => ({
          items: [{
            id: 'instance-1',
            displayName: 'Phoenix instance',
            region: 'phx',
            lifecycleState: 'RUNNING',
          }],
        }),
      }),
      withRetry: (operation) => operation(),
    });

    expect(result.resources).toEqual([
      expect.objectContaining({ externalResourceId: 'instance-1', regionId: 'us-phoenix-1' }),
    ]);
  });

  test('searches inventory in every discovered region and keeps each resource region', async () => {
    const searchedRegions: string[] = [];
    const rateLimitedRegions: string[] = [];
    const result = await collectOciInventory(buildJob({
      metadata: {
        ociMetricDefinitions: [
          { compartmentId: 'tenancy-1', namespace: 'oci_blockstore', metricName: 'VolumeGuaranteedIOPS', resourceId: 'ocid1.volume.oc1..exampleid0038', regionId: 'us-phoenix-1' },
          { compartmentId: 'tenancy-1', namespace: 'oci_blockstore', metricName: 'VolumeGuaranteedIOPS', resourceId: 'ocid1.bootvolume.oc1..exampleid0001', regionId: 'us-ashburn-1' },
        ],
      },
    }), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'], apiCallCount: 0, status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1, discoveredCompartmentCount: 0,
      }),
      discoverRegions: async () => ({
        regionIds: ['us-phoenix-1', 'us-ashburn-1'], apiCallCount: 1, status: 'COMPLETE', warnings: [],
      }),
      createComputeClient: () => ({ listInstances: async () => ({ items: [] }) }),
      createResourceSearchClient: (regionalJob) => ({
        searchResources: async () => {
          const regionId = String(regionalJob.requestContext?.['regionId']);
          searchedRegions.push(regionId);
          const isPhoenix = regionId === 'us-phoenix-1';
          return { resourceSummaryCollection: { items: [{
            identifier: isPhoenix ? 'ocid1.volume.oc1..exampleid0038' : 'ocid1.bootvolume.oc1..exampleid0001',
            displayName: isPhoenix ? 'Datos Phoenix' : 'Sistema Ashburn',
            resourceType: isPhoenix ? 'volume' : 'bootVolume',
            compartmentId: 'tenancy-1',
          }] } };
        },
      }),
      withRateLimit: async (regionalJob, api, operation) => {
        if (api === 'resourceSearch') rateLimitedRegions.push(String(regionalJob.requestContext?.['regionId']));
        return operation();
      },
      withRetry: (operation) => operation(),
    });

    expect(searchedRegions).toEqual(['us-phoenix-1', 'us-ashburn-1']);
    expect(rateLimitedRegions).toEqual(searchedRegions);
    expect(result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalResourceId: 'ocid1.volume.oc1..exampleid0038', name: 'Datos Phoenix', resourceType: 'BLOCK_VOLUME', regionId: 'us-phoenix-1' }),
      expect.objectContaining({ externalResourceId: 'ocid1.bootvolume.oc1..exampleid0001', name: 'Sistema Ashburn', resourceType: 'BOOT_VOLUME', regionId: 'us-ashburn-1' }),
    ]));
    expect(result.coverage).toMatchObject({
      resourceSearchStatus: 'COMPLETE', resourceSearchRegionCount: 2, resourceSearchFailedRegionCount: 0,
      resourceSearchResourceCount: 2,
    });
  });

  test('marks Resource Search partial when one regional query fails', async () => {
    const result = await collectOciInventory(buildJob({}), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'], apiCallCount: 0, status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1, discoveredCompartmentCount: 0,
      }),
      discoverRegions: async () => ({
        regionIds: ['us-phoenix-1', 'us-ashburn-1'], apiCallCount: 1, status: 'COMPLETE', warnings: [],
      }),
      createComputeClient: () => ({ listInstances: async () => ({ items: [] }) }),
      createResourceSearchClient: (regionalJob) => ({
        searchResources: async () => {
          if (regionalJob.requestContext?.['regionId'] === 'us-phoenix-1') throw new Error('regional search unavailable');
          return { resourceSummaryCollection: { items: [{
            identifier: 'ocid1.volume.oc1..exampleid0035', displayName: 'Almacenamiento Ashburn', resourceType: 'volume', compartmentId: 'tenancy-1',
          }] } };
        },
      }),
      withRetry: (operation) => operation(),
    });

    expect(result.resources).toEqual([
      expect.objectContaining({ externalResourceId: 'ocid1.volume.oc1..exampleid0035', name: 'Almacenamiento Ashburn', regionId: 'us-ashburn-1' }),
    ]);
    expect(result.coverage).toMatchObject({
      resourceSearchStatus: 'PARTIAL', resourceSearchRegionCount: 2, resourceSearchFailedRegionCount: 1,
    });
    expect(result.warnings).toEqual([expect.stringContaining('us-phoenix-1')]);
  });

  test('collects Object Storage buckets with a canonical id and a safe bucket alias', async () => {
    const listBuckets = vi.fn().mockResolvedValue({
      items: [{
        name: 'cost-reports',
        timeCreated: '2026-08-01T00:00:00.000Z',
        freeformTags: { owner: 'finops' },
      }],
    });
    const result = await collectOciInventory(buildJob({
      metadata: {
        ociFocusReportLocations: [{ namespaceName: 'namespace-1', bucketName: 'focus-bucket', prefix: 'FOCUS Reports' }],
        capabilityValidation: {
          capabilities: [{ capability: 'STORAGE', metadata: { namespaceName: 'namespace-1' } }],
        },
      },
    }), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'], apiCallCount: 0, status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1, discoveredCompartmentCount: 0,
      }),
      discoverRegions: async () => ({
        regionIds: ['us-ashburn-1'], apiCallCount: 0, status: 'COMPLETE', warnings: [],
      }),
      createComputeClient: () => ({ listInstances: async () => ({ items: [] }) }),
      createObjectStorageClient: () => ({ listBuckets, close: vi.fn() }),
      withRetry: (operation) => operation(),
    });

    expect(listBuckets).toHaveBeenCalledWith({
      namespaceName: 'namespace-1',
      compartmentId: 'tenancy-1',
      limit: 1000,
    });
    expect(result.resources).toEqual([
      expect.objectContaining({
        externalResourceId: 'namespace-1/cost-reports',
        name: 'cost-reports',
        resourceType: 'OBJECT_STORAGE_BUCKET',
        serviceName: 'Oracle Object Storage',
        rawResource: expect.objectContaining({ aliases: ['cost-reports'] }),
      }),
    ]);
    expect(result.coverage).toMatchObject({ objectStorageStatus: 'COMPLETE', objectStorageResourceCount: 1 });
  });

  test('discovers the Object Storage namespace from OCI instead of trusting a stale validation value', async () => {
    const getNamespace = vi.fn().mockResolvedValue({ value: 'live-namespace' });
    const listBuckets = vi.fn().mockResolvedValue({ items: [] });
    const result = await collectOciInventory(buildJob({}), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'], apiCallCount: 0, status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1, discoveredCompartmentCount: 0,
      }),
      discoverRegions: async () => ({
        regionIds: ['us-ashburn-1'], apiCallCount: 0, status: 'COMPLETE', warnings: [],
      }),
      createComputeClient: () => ({ listInstances: async () => ({ items: [] }) }),
      createObjectStorageClient: () => ({ getNamespace, listBuckets }),
      withRetry: (operation) => operation(),
    });

    expect(getNamespace).toHaveBeenCalledWith({ compartmentId: 'tenancy-1' });
    expect(listBuckets).toHaveBeenCalledWith({
      namespaceName: 'live-namespace', compartmentId: 'tenancy-1', limit: 1000,
    });
    expect(result.coverage).toMatchObject({ objectStorageStatus: 'COMPLETE' });
  });

  test('propagates cancellation to inventory SDK clients instead of converting it to a partial success', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    let clientSignal: AbortSignal | undefined;
    const result = collectOciInventory(buildJob({}), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'], apiCallCount: 0, status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1, discoveredCompartmentCount: 0,
      }),
      discoverRegions: async () => ({
        regionIds: ['us-ashburn-1'], apiCallCount: 0, status: 'COMPLETE', warnings: [],
      }),
      createComputeClient: (_job, signal) => {
        clientSignal = signal;
        return {
          close,
          listInstances: () => new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
          }),
        };
      },
      withRetry: (operation, signal) => operation(signal),
    }, controller.signal);

    setTimeout(() => controller.abort(), 0);
    await expect(result).rejects.toThrow('request aborted');
    expect(clientSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  test('propagates cancellation through Object Storage inventory and its rate limiter', async () => {
    const controller = new AbortController();
    let clientSignal: AbortSignal | undefined;
    let limiterSignal: AbortSignal | undefined;
    const result = collectOciInventory(buildJob({
      metadata: { ociFocusReportLocations: [{ namespaceName: 'namespace-1' }] },
    }), {
      discoverCompartments: async () => ({
        compartmentIds: ['tenancy-1'], apiCallCount: 0, status: 'CONFIGURED_ONLY',
        configuredCompartmentCount: 1, discoveredCompartmentCount: 0,
      }),
      discoverRegions: async () => ({
        regionIds: ['us-ashburn-1'], apiCallCount: 0, status: 'COMPLETE', warnings: [],
      }),
      createComputeClient: () => ({ listInstances: async () => ({ items: [] }) }),
      createObjectStorageClient: (_job, signal) => {
        clientSignal = signal;
        return {
          listBuckets: async () => new Promise((_, reject) => {
            const abort = (): void => reject(new Error('request aborted'));
            if (signal?.aborted === true) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          }),
        };
      },
      withRetry: (operation, signal) => operation(signal),
      withRateLimit: (_job, _api, operation, signal) => {
        limiterSignal = signal;
        return operation();
      },
    }, controller.signal);

    setTimeout(() => controller.abort(), 0);
    await expect(result).rejects.toThrow('request aborted');
    expect(clientSignal?.aborted).toBe(true);
    expect(limiterSignal).toBe(controller.signal);
  });
});

function buildJob(overrides: {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly credentials?: CloudIngestionJobContext['connection']['credentials'];
  readonly defaultRegion?: string;
}): CloudIngestionJobContext {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    sourceType: 'INVENTORY',
    targetStart: new Date('2026-08-10T00:00:00Z'),
    targetEnd: new Date('2026-08-10T01:00:00Z'),
    connection: {
      id: 'connection-1',
      tenantId: 'tenant-1',
      providerCode: 'oci',
      rootExternalId: 'tenancy-1',
      credentials: overrides.credentials ?? [],
      metadata: overrides.metadata ?? {},
      defaultRegion: overrides.defaultRegion ?? 'us-ashburn-1',
    },
  };
}
