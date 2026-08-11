import { describe, expect, test, vi } from 'vitest';
import { backfillHistoricalOciResources } from './PrismaHistoricalOciResourceBackfill.js';

describe('backfillHistoricalOciResources', () => {
  test('paginates exact supported OCI cost identities and remains dry-run safe', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{
        cloud_connection_id: 'connection-1', resource_id: 'ocid1.vnic.oc1.test',
        first_seen_at: new Date('2026-05-01T00:00:00Z'), last_seen_at: new Date('2026-05-03T00:00:00Z'),
        service_name: 'NETWORK', region_id: 'sa-bogota-1',
      }])
      .mockResolvedValueOnce([]);
    const createMany = vi.fn();

    const result = await backfillHistoricalOciResources({
      $queryRaw: queryRaw,
      cloudResource: { createMany },
    } as never, 'tenant-1', 100, false);

    expect(result).toMatchObject({ examined: 1, candidates: 1, inserted: 0, mode: 'DRY_RUN' });
    expect(result.byResourceType).toEqual({ VNIC: 1 });
    expect(createMany).not.toHaveBeenCalled();
  });

  test('inserts historical references idempotently in apply mode', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{
        cloud_connection_id: 'connection-1', resource_id: 'ocid1.bootvolume.oc1.test',
        first_seen_at: new Date('2026-05-01T00:00:00Z'), last_seen_at: new Date('2026-05-03T00:00:00Z'),
        service_name: 'BLOCK_STORAGE', region_id: null,
      }])
      .mockResolvedValueOnce([]);
    const createMany = vi.fn().mockResolvedValue({ count: 1 });

    const result = await backfillHistoricalOciResources({
      $queryRaw: queryRaw,
      cloudResource: { createMany },
    } as never, 'tenant-1', 100, true);

    expect(result).toMatchObject({ candidates: 1, inserted: 1, mode: 'APPLY' });
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });
});
