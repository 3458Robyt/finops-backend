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
});

function buildJob(overrides: {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly credentials?: CloudIngestionJobContext['connection']['credentials'];
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
    },
  };
}
