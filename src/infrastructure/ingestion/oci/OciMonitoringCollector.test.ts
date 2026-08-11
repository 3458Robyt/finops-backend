import { describe, expect, test, vi } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { collectOciTechnicalMetrics } from './OciMonitoringCollector.js';

describe('OCI monitoring collector', () => {
  test('returns an explicit empty result without constructing a client', async () => {
    const createClient = vi.fn();
    const result = await collectOciTechnicalMetrics(buildJob({}), {
      createClient,
      withRetry: (operation) => operation(),
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(result.metricSamples).toEqual([]);
    expect(result.coverage).toMatchObject({ metricDefinitions: 0 });
  });

  test('normalizes datapoints and closes the SDK client', async () => {
    const close = vi.fn();
    const result = await collectOciTechnicalMetrics(buildJob({
      ociMetricDefinitions: [{
        compartmentId: 'compartment-1',
        namespace: 'oci_computeagent',
        metricName: 'CpuUtilization',
        resourceId: 'instance-1',
        unit: 'Percent',
      }],
    }), {
      createClient: () => ({
        close,
        listMetrics: async () => ({}),
        summarizeMetricsData: async () => ({
          items: [{
            name: 'CpuUtilization',
            namespace: 'oci_computeagent',
            dimensions: { resourceId: 'instance-1' },
            aggregatedDatapoints: [{ timestamp: '2026-08-10T00:30:00Z', value: 12.5 }],
          }],
        }),
      }),
      withRetry: (operation) => operation(),
    });

    expect(close).toHaveBeenCalledOnce();
    expect(result.metricSamples).toEqual([
      expect.objectContaining({
        externalResourceId: 'instance-1',
        metricName: 'CpuUtilization',
        metricUnit: 'Percent',
        value: 12.5,
        granularitySeconds: 1800,
      }),
    ]);
    expect(result.coverage).toMatchObject({ samples: 1, metricDefinitions: 1 });
  });
});

function buildJob(metadata: Readonly<Record<string, unknown>>): CloudIngestionJobContext {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    sourceType: 'TECHNICAL_METRIC',
    targetStart: new Date('2026-08-10T00:00:00Z'),
    targetEnd: new Date('2026-08-10T01:00:00Z'),
    connection: {
      id: 'connection-1',
      tenantId: 'tenant-1',
      providerCode: 'oci',
      rootExternalId: 'ocid1.tenancy.oc1.test',
      credentials: [],
      metadata,
    },
  };
}
