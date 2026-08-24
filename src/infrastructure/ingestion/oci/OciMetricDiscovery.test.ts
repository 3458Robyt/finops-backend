import { describe, expect, it, vi } from 'vitest';
import type { CloudIngestionConnection } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { discoverOciMetricDefinitions } from './OciMetricDiscovery.js';

function connection(metadata?: Readonly<Record<string, unknown>>): CloudIngestionConnection {
  return {
    id: 'connection-1',
    tenantId: 'tenant-1',
    providerCode: 'oci',
    rootExternalId: 'tenancy-1',
    defaultRegion: 'us-phoenix-1',
    credentials: [],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe('discoverOciMetricDefinitions', () => {
  it('omits the namespace filter by default so OCI returns every namespace', async () => {
    const requests: unknown[] = [];
    const client = {
      listMetrics: vi.fn(async (request: unknown) => {
        requests.push(request);
        const details = (request as { readonly listMetricsDetails: Record<string, unknown> }).listMetricsDetails;
        if (Array.isArray(details.groupBy)) {
          return { items: [{ namespace: 'oci_computeagent' }] };
        }
        return {
          items: [{ namespace: 'oci_computeagent', name: 'CpuUtilization', dimensions: { resourceId: 'instance-1' } }],
        };
      }),
      close: vi.fn(),
    };

    const result = await discoverOciMetricDefinitions(connection(), {
      createClient: () => client,
      discoverRegions: async () => ({ regions: ['us-phoenix-1'], apiCallCount: 1 }),
      discoverCompartments: async () => ({ compartmentIds: ['compartment-1'], apiCallCount: 1, status: 'COMPLETE' }),
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(requests).toHaveLength(2);
    const namespaceDiscoveryRequest = requests[0] as { readonly listMetricsDetails: Record<string, unknown> };
    expect(namespaceDiscoveryRequest.listMetricsDetails).toEqual({ groupBy: ['namespace'] });
    const metricRequest = requests[1] as { readonly listMetricsDetails: Record<string, unknown> };
    expect(metricRequest.listMetricsDetails).toEqual({ namespace: 'oci_computeagent' });
    expect(result.definitions).toHaveLength(1);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('honors an explicit namespace allow-list without using the SDK-incompatible namespaceName key', async () => {
    const request = vi.fn(async () => ({
      items: [{ namespace: 'oci_computeagent', name: 'MemoryUtilization' }],
    }));
    const client = { listMetrics: request, close: vi.fn() };

    await discoverOciMetricDefinitions(connection({ ociMetricNamespaces: ['oci_computeagent'] }), {
      createClient: () => client,
      discoverRegions: async () => ({ regions: ['us-phoenix-1'], apiCallCount: 1 }),
      discoverCompartments: async () => ({ compartmentIds: ['compartment-1'], apiCallCount: 1, status: 'COMPLETE' }),
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      listMetricsDetails: { namespace: 'oci_computeagent' },
    }));
  });
});
