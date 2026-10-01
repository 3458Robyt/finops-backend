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

const scope = { regionId: 'us-phoenix-1', compartmentId: 'compartment-1' } as const;

describe('discoverOciMetricDefinitions', () => {
  it('discovers namespaces only inside the explicitly supplied region and compartment', async () => {
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
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    }, scope);

    expect(requests).toHaveLength(2);
    const namespaceDiscoveryRequest = requests[0] as { readonly listMetricsDetails: Record<string, unknown> };
    expect(namespaceDiscoveryRequest.listMetricsDetails).toEqual({ groupBy: ['namespace'] });
    const metricRequest = requests[1] as { readonly listMetricsDetails: Record<string, unknown> };
    expect(metricRequest.listMetricsDetails).toEqual({ namespace: 'oci_computeagent' });
    expect(result.definitions).toHaveLength(1);
    expect(result).toMatchObject({ regions: ['us-phoenix-1'], compartments: ['compartment-1'], truncated: false, apiCallCount: 2 });
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ compartmentId: 'compartment-1' }),
    ]));
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('honors a configured namespace inside the explicit scope', async () => {
    const request = vi.fn(async () => ({
      items: [{ namespace: 'oci_computeagent', name: 'MemoryUtilization' }],
    }));
    const client = { listMetrics: request, close: vi.fn() };

    const result = await discoverOciMetricDefinitions(connection({ ociMetricNamespaces: ['oci_computeagent'] }), {
      createClient: () => client,
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    }, scope);

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      compartmentId: 'compartment-1',
      listMetricsDetails: { namespace: 'oci_computeagent' },
    }));
    expect(result.apiCallCount).toBe(1);
  });

  it('propagates cancellation to the active provider request', async () => {
    const controller = new AbortController();
    const client = {
      listMetrics: vi.fn((_request: unknown) => new Promise<{ readonly items: readonly [] }>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      })),
      close: vi.fn(),
    };
    const discovery = discoverOciMetricDefinitions(connection({ ociMetricNamespaces: ['oci_computeagent'] }), {
      createClient: (_job, signal) => {
        expect(signal).toBe(controller.signal);
        return client;
      },
      withRetry: async <T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error('cancelled');
        return operation(signal);
      },
    }, scope, controller.signal);

    controller.abort();
    await expect(discovery).rejects.toThrow('cancelled');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('requires a region and compartment and never falls back to tenancy-wide discovery', async () => {
    const createClient = vi.fn();
    await expect(discoverOciMetricDefinitions(connection(), {
      createClient,
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    }, { regionId: '', compartmentId: '' })).rejects.toThrow(/región y compartment explícitos/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('stops after the fixed API-call budget and reports truncation', async () => {
    const client = {
      listMetrics: vi.fn(async () => ({ items: [], opcNextPage: 'next' })),
      close: vi.fn(),
    };
    const result = await discoverOciMetricDefinitions(connection({ ociMetricNamespaces: ['oci_computeagent'] }), {
      createClient: () => client,
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    }, scope);

    expect(client.listMetrics).toHaveBeenCalledTimes(30);
    expect(result).toMatchObject({ apiCallCount: 30, truncated: true });
    expect(result.warnings.join(' ')).toMatch(/límite seguro/i);
  });

  it('counts and rate-limits every retry attempt against the API-call budget', async () => {
    let actualCalls = 0;
    let retryAttempts = 0;
    let rateLimitCalls = 0;
    const client = {
      listMetrics: vi.fn(async () => {
        actualCalls += 1;
        if (actualCalls % 2 === 1) throw new Error('transient network error');
        return { items: [], opcNextPage: `page-${actualCalls}` };
      }),
      close: vi.fn(),
    };
    const result = await discoverOciMetricDefinitions(connection({ ociMetricNamespaces: ['oci_computeagent'] }), {
      createClient: () => client,
      withRetry: async <T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
        try {
          return await operation(signal);
        } catch {
          retryAttempts += 1;
          return operation(signal);
        }
      },
      withRateLimit: async <T>(operation: () => Promise<T>) => {
        rateLimitCalls += 1;
        return operation();
      },
    }, scope);

    expect(actualCalls).toBe(30);
    expect(retryAttempts).toBe(15);
    expect(rateLimitCalls).toBe(actualCalls);
    expect(result).toMatchObject({ apiCallCount: 30, truncated: true });
  });

  it('does not mark a complete result exactly at the definition cap as truncated', async () => {
    const items = Array.from({ length: 500 }, (_, index) => ({
      namespace: 'oci_computeagent', name: 'CpuUtilization', dimensions: { resourceId: `instance-${index}` },
    }));
    const client = { listMetrics: vi.fn(async () => ({ items })), close: vi.fn() };
    const result = await discoverOciMetricDefinitions(connection({ ociMetricNamespaces: ['oci_computeagent'] }), {
      createClient: () => client,
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    }, scope);

    expect(result.definitions).toHaveLength(500);
    expect(result.truncated).toBe(false);
  });

  it('caps returned definitions instead of materializing an unbounded catalog', async () => {
    const items = Array.from({ length: 501 }, (_, index) => ({
      namespace: 'oci_computeagent', name: 'CpuUtilization', dimensions: { resourceId: `instance-${index}` },
    }));
    const client = { listMetrics: vi.fn(async () => ({ items })), close: vi.fn() };
    const result = await discoverOciMetricDefinitions(connection({ ociMetricNamespaces: ['oci_computeagent'] }), {
      createClient: () => client,
      withRetry: async <T>(operation: () => Promise<T>) => operation(),
    }, scope);

    expect(result.definitions).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });
});
