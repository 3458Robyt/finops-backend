import { describe, expect, it, vi } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { discoverOciHomeRegion } from './OciRegionDiscovery.js';

describe('discoverOciHomeRegion', () => {
  it('selects the region marked as home instead of the configured region', async () => {
    const close = vi.fn();
    const region = await discoverOciHomeRegion(buildJob(), {
      createIdentityClient: () => ({
        listRegionSubscriptions: async () => ({ items: [
          { regionName: 'sa-bogota-1', status: 'READY', isHomeRegion: false },
          { regionName: 'us-phoenix-1', status: 'READY', isHomeRegion: true },
        ] }),
        close,
      }),
      withRetry: async (operation) => operation(),
    });

    expect(region).toBe('us-phoenix-1');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects missing or ambiguous home-region markers rather than guessing', async () => {
    const listRegionSubscriptions = vi.fn(async () => ({ items: [
      { regionName: 'sa-bogota-1', status: 'READY', isHomeRegion: false },
      { regionName: 'us-phoenix-1', status: 'READY', isHomeRegion: true },
      { regionName: 'us-ashburn-1', status: 'READY', isHomeRegion: true },
    ] }));
    await expect(discoverOciHomeRegion(buildJob(), {
      createIdentityClient: () => ({ listRegionSubscriptions, close: vi.fn() }),
      withRetry: async (operation) => operation(),
    })).rejects.toThrow('no devolvió una única región principal');
  });
});

function buildJob(): CloudIngestionJobContext {
  return {
    id: 'job-1', tenantId: 'tenant-1', cloudConnectionId: 'connection-1',
    sourceType: 'BILLING_EXPORT', targetStart: new Date('2026-08-01T00:00:00Z'),
    targetEnd: new Date('2026-08-02T00:00:00Z'), attempt: 1,
    connection: {
      id: 'connection-1', tenantId: 'tenant-1', providerCode: 'oci',
      rootExternalId: 'tenancy-test', defaultRegion: 'sa-bogota-1', credentials: [],
    },
  };
}
