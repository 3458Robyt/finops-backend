import { describe, expect, test, vi } from 'vitest';
import type { NormalizedCloudResource } from '../../domain/interfaces/ICloudIngestionProvider.js';
import {
  insertHistoricalCloudResources,
  upsertNormalizedCloudResources,
} from './PrismaCloudResourceCatalog.js';

describe('PrismaCloudResourceCatalog', () => {
  test('inserts historical references without updating existing live inventory', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const resource = historicalResource();

    await insertHistoricalCloudResources({ cloudResource: { createMany } } as never, [resource]);

    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [expect.objectContaining({
        externalResourceId: resource.externalResourceId,
        firstSeenAt: resource.firstSeenAt,
        lastSeenAt: resource.lastSeenAt,
      })],
    }));
  });

  test('uses provider observation times when upserting live resources', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({ id: 'resource-1', externalResourceId: 'ocid1.instance.oc1.test' });
    const resource = { ...historicalResource(), externalResourceId: 'ocid1.instance.oc1.test' };

    const ids = await upsertNormalizedCloudResources({ cloudResource: { findUnique, create } } as never, [resource]);

    expect(ids.get(resource.externalResourceId)).toBe('resource-1');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ firstSeenAt: resource.firstSeenAt, lastSeenAt: resource.lastSeenAt }),
    }));
  });

  test('does not let metric-derived identity overwrite authoritative inventory fields', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'resource-1',
      externalResourceId: 'ocid1.instance.oc1.test',
      identityPriority: 4,
      lastSeenAt: new Date('2026-05-03T00:00:00Z'),
    });
    const update = vi.fn().mockResolvedValue({ id: 'resource-1', externalResourceId: 'ocid1.instance.oc1.test' });

    await upsertNormalizedCloudResources({ cloudResource: { findUnique, update } } as never, [{
      ...historicalResource(),
      externalResourceId: 'ocid1.instance.oc1.test',
      name: undefined,
      identitySource: 'METRIC_DERIVED',
      identityPriority: 0,
      rawResource: { source: 'METRIC_DERIVED' },
    }]);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ resourceType: 'BOOT_VOLUME', serviceName: 'Oracle Block Volume' }),
    }));
    expect(update.mock.calls[0]?.[0].data).toEqual({ lastSeenAt: expect.any(Date) });
  });
});

function historicalResource(): NormalizedCloudResource {
  return {
    tenantId: 'tenant-1', cloudConnectionId: 'connection-1', provider: 'OCI',
    externalResourceId: 'ocid1.bootvolume.oc1.test', name: 'boot', resourceType: 'BOOT_VOLUME',
    serviceName: 'Oracle Block Volume', status: 'UNKNOWN',
    firstSeenAt: new Date('2026-05-01T00:00:00Z'), lastSeenAt: new Date('2026-05-03T00:00:00Z'),
    rawResource: { source: 'OCI_FOCUS_HISTORICAL_REFERENCE' },
  };
}
