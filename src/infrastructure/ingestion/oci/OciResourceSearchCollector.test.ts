import { describe, expect, test, vi } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { collectOciResourceSearchInventory } from './OciResourceSearchCollector.js';

describe('collectOciResourceSearchInventory', () => {
  test('paginates configured resource types and normalizes exact OCI identities', async () => {
    const close = vi.fn();
    let rateLimitCalls = 0;
    const searchResources = vi.fn()
      .mockResolvedValueOnce({
        resourceSummaryCollection: {
          items: [{
            resourceType: 'bootvolume',
            identifier: 'ocid1.bootvolume.oc1..exampleid0002',
            compartmentId: 'ocid1.compartment.oc1..exampleid0005',
            displayName: 'Boot principal',
            lifecycleState: 'AVAILABLE',
            freeformTags: { owner: 'finops' },
          }],
        },
        opcNextPage: 'page-2',
      })
      .mockResolvedValueOnce({
        resourceSummaryCollection: {
          items: [{
            resourceType: 'bootvolumebackup',
            identifier: 'ocid1.bootvolumebackup.oc1..exampleid0003',
            compartmentId: 'ocid1.compartment.oc1..exampleid0005',
            lifecycleState: 'TERMINATED',
          }],
        },
      });

    const result = await collectOciResourceSearchInventory(buildJob(), {
      createClient: () => ({ close, searchResources }),
      withRetry: (operation) => operation(),
      withRateLimit: async (_job, operation) => {
        rateLimitCalls += 1;
        return operation();
      },
    });

    expect(searchResources).toHaveBeenNthCalledWith(1, expect.objectContaining({
      searchDetails: { type: 'Structured', query: 'query bootvolume resources' },
      limit: 1000,
    }));
    expect(searchResources).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 'page-2' }));
    expect(close).toHaveBeenCalledTimes(2);
    expect(rateLimitCalls).toBe(2);
    expect(result.apiCallCount).toBe(2);
    expect(result.resources).toEqual([
      expect.objectContaining({
        externalResourceId: 'ocid1.bootvolume.oc1..exampleid0002',
        resourceType: 'BOOT_VOLUME',
        serviceName: 'Oracle Block Volume',
        status: 'ACTIVE',
        tags: { owner: 'finops' },
        rawResource: expect.objectContaining({
          source: 'OCI_RESOURCE_SEARCH',
          compartmentId: 'ocid1.compartment.oc1..exampleid0005',
          normalizerVersion: 'oci-resource-search-v1',
        }),
      }),
      expect.objectContaining({
        externalResourceId: 'ocid1.bootvolumebackup.oc1..exampleid0003',
        resourceType: 'BOOT_VOLUME_BACKUP',
        status: 'TERMINATED',
      }),
    ]);
  });

  test('filters Resource Search results by configured compartments', async () => {
    const result = await collectOciResourceSearchInventory(buildJob({
      ociInventoryIncludeCompartments: ['included'],
      ociInventoryExcludeCompartments: ['excluded'],
    }), {
      createClient: () => ({
        searchResources: async () => ({ resourceSummaryCollection: { items: [
          { resourceType: 'bootvolume', identifier: 'included-id', compartmentId: 'included' },
          { resourceType: 'bootvolume', identifier: 'excluded-id', compartmentId: 'excluded' },
          { resourceType: 'bootvolume', identifier: 'other-id', compartmentId: 'other' },
        ] } }),
      }),
      withRetry: (operation) => operation(),
    });

    expect(result.resources.map((resource) => resource.externalResourceId)).toEqual(['included-id']);
    expect(result.filteredResourceCount).toBe(2);
  });

  test('normalizes OCI Resource Search date strings without losing the resource', async () => {
    const result = await collectOciResourceSearchInventory(buildJob(), {
      createClient: () => ({
        searchResources: async () => ({
          resourceSummaryCollection: {
            items: [{
              resourceType: 'instance',
              identifier: 'ocid1.instance.oc1..exampleid0017',
              compartmentId: 'tenancy-1',
              displayName: 'Instancia con fecha serializada',
              timeCreated: '2026-09-21T00:00:00.000Z',
              lifecycleState: 'RUNNING',
            }],
          },
        }),
      }),
      withRetry: (operation) => operation(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.resources).toEqual([
      expect.objectContaining({
        externalResourceId: 'ocid1.instance.oc1..exampleid0017',
        rawResource: expect.objectContaining({
          timeCreated: '2026-09-21T00:00:00.000Z',
        }),
      }),
    ]);
  });
});

function buildJob(metadata: Readonly<Record<string, unknown>> = {}): CloudIngestionJobContext {
  return {
    id: 'job-1', tenantId: 'tenant-1', cloudConnectionId: 'connection-1', sourceType: 'INVENTORY',
    targetStart: new Date('2026-08-10T00:00:00Z'), targetEnd: new Date('2026-08-10T01:00:00Z'),
    connection: {
      id: 'connection-1', tenantId: 'tenant-1', providerCode: 'oci', rootExternalId: 'tenancy-1',
      defaultRegion: 'sa-bogota-1', credentials: [],
      metadata: { ociInventoryResourceTypes: ['bootvolume'], ...metadata },
    },
  };
}
