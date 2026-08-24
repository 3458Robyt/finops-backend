import { describe, expect, test, vi } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { collectOciTechnicalMetrics, resolveOciRequestRange } from './OciMonitoringCollector.js';

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

    const samples = await materializeSamples(result);
    expect(close).toHaveBeenCalledOnce();
    expect(samples).toEqual([
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

  test('uses the provider-native statistic in each OCI query', async () => {
    const queries: string[] = [];
    const result = await collectOciTechnicalMetrics(buildJob({
      ociMetricDefinitions: [{
        compartmentId: 'compartment-1',
        namespace: 'oci_computeagent',
        metricName: 'CpuUtilization',
        resourceId: 'instance-1',
        unit: 'Percent',
        statistics: ['P95', 'LATEST'],
      }],
    }), {
      createClient: () => ({
        summarizeMetricsData: async (request) => {
          queries.push(request.summarizeMetricsDataDetails.query);
          return {
            items: [{
              name: 'CpuUtilization',
              namespace: 'oci_computeagent',
              dimensions: { resourceId: 'instance-1' },
              aggregatedDatapoints: [{ timestamp: '2026-08-10T00:30:00Z', value: 95 }],
            }],
          };
        },
      }),
      withRetry: (operation) => operation(),
    });

    const samples = await materializeSamples(result);
    expect(queries).toEqual([
      'CpuUtilization[30m]{resourceId = "instance-1"}.percentile(0.95)',
      'CpuUtilization[30m]{resourceId = "instance-1"}.last()',
    ]);
    expect(samples.map((sample) => sample.statistic)).toEqual(['P95', 'LATEST']);
  });

  test('groups confirmed resources into one MQL request and keeps each returned stream', async () => {
    const queries: string[] = [];
    const result = await collectOciTechnicalMetrics(buildJob({
      ociMetricDefinitions: [
        metricDefinition('instance-1'),
        metricDefinition('instance-2'),
      ],
    }), {
      createClient: () => ({
        summarizeMetricsData: async (request) => {
          queries.push(request.summarizeMetricsDataDetails.query);
          return {
            items: [
              metricStream('instance-1', 12),
              metricStream('instance-2', 34),
              metricStream('unconfirmed-instance', 999),
            ],
          };
        },
      }),
      withRetry: (operation) => operation(),
    });

    const samples = await materializeSamples(result);
    expect(queries).toEqual(['CpuUtilization[30m].groupBy(resourceId).mean()']);
    expect(samples.map((sample) => sample.externalResourceId)).toEqual(['instance-1', 'instance-2']);
    expect(result.apiCallCount).toBe(1);
  });

  test('drains more than the bounded queue without leaving producers blocked', async () => {
    const definitions = Array.from({ length: 40 }, (_, index) => ({
      compartmentId: 'compartment-1',
      namespace: 'oci_computeagent',
      metricName: `Metric${index}`,
      resourceId: 'instance-1',
      unit: 'Percent',
    }));
    const result = await collectOciTechnicalMetrics(buildJob({ ociMetricDefinitions: definitions }), {
      createClient: () => ({
        summarizeMetricsData: async () => ({ items: [metricStream('instance-1', 42)] }),
      }),
      withRetry: (operation) => operation(),
    });

    const samples = [];
    if (result.metricBatches !== undefined) {
      for await (const batch of result.metricBatches) {
        samples.push(...batch);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    expect(samples).toHaveLength(40);
    expect(result.apiCallCount).toBe(40);
  }, 10_000);

  test('queries confirmed resources at tenancy scope before falling back to compartments', async () => {
    const requests: Array<{ compartmentId: string; compartmentIdInSubtree?: boolean }> = [];
    const result = await collectOciTechnicalMetrics(buildJob({
      ociMetricDefinitions: [
        metricDefinition('instance-1', 'compartment-1'),
        metricDefinition('instance-2', 'compartment-2'),
      ],
    }), {
      createClient: () => ({
        summarizeMetricsData: async (request) => {
          requests.push({
            compartmentId: request.compartmentId,
            ...(request.compartmentIdInSubtree === undefined
              ? {}
              : { compartmentIdInSubtree: request.compartmentIdInSubtree }),
          });
          return { items: [] };
        },
      }),
      withRetry: (operation) => operation(),
    });

    await materializeSamples(result);
    expect(requests).toEqual([{
      compartmentId: 'ocid1.tenancy.oc1.test',
      compartmentIdInSubtree: true,
    }]);
  });

  test('keeps a delayed 90-day job inside OCI rolling retention', () => {
    const now = new Date('2026-08-16T18:36:00Z');
    const range = resolveOciRequestRange({
      targetStart: new Date('2026-05-18T18:30:00Z'),
      targetEnd: new Date('2026-05-25T18:30:00Z'),
    }, now);

    expect(range.startTime.toISOString()).toBe('2026-05-18T18:51:00.000Z');
    expect(range.endTime.toISOString()).toBe('2026-05-25T18:30:00.000Z');
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
      defaultRegion: 'us-ashburn-1',
      credentials: [],
      metadata,
    },
  };
}

function metricDefinition(resourceId: string, compartmentId = 'compartment-1'): Record<string, unknown> {
  return {
    compartmentId,
    namespace: 'oci_computeagent',
    metricName: 'CpuUtilization',
    resourceId,
    regionId: 'us-ashburn-1',
    dimensions: { resourceId },
    unit: 'Percent',
  };
}

function metricStream(resourceId: string, value: number): {
  readonly name: string;
  readonly namespace: string;
  readonly dimensions: { readonly resourceId: string };
  readonly aggregatedDatapoints: readonly [{ readonly timestamp: string; readonly value: number }];
} {
  return {
    name: 'CpuUtilization',
    namespace: 'oci_computeagent',
    dimensions: { resourceId },
    aggregatedDatapoints: [{ timestamp: '2026-08-10T00:30:00Z', value }],
  };
}

async function materializeSamples(result: Awaited<ReturnType<typeof collectOciTechnicalMetrics>>) {
  const samples = [...result.metricSamples];
  if (result.metricBatches !== undefined) {
    for await (const batch of result.metricBatches) samples.push(...batch);
  }
  return samples;
}
