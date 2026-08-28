import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaResourceMetricSummaryReader } from './PrismaResourceMetricSummaryReader.js';

describe('PrismaResourceMetricSummaryReader', () => {
  it('maps the daily rollup projection without loading raw samples', async () => {
    let queryCalls = 0;
    const prisma = {
      $queryRaw: async () => {
        queryCalls += 1;
        return [{
          provider: 'OCI',
          external_resource_id: 'ocid1.instance.example',
          cloud_resource_id: 'resource-1',
          cloud_connection_id: 'connection-1',
          provider_namespace: 'oci_computeagent',
          region_id: 'us-ashburn-1',
          dimensions_hash: 'dimensions',
          resource_type: 'compute_instance',
          service_name: 'OCI Compute',
          metric_name: 'CpuUtilization',
          metric_unit: 'Percent',
          statistic: 'MEAN',
          sample_count: 48n,
          coverage_days: 2n,
          min_value: 3,
          max_value: 91,
          avg_value: 22.5,
          p50_value: 22.5,
          p95_value: 22.5,
          p99_value: 22.5,
          latest_value: 18,
          first_sampled_at: new Date('2026-08-22T00:00:00.000Z'),
          latest_sampled_at: new Date('2026-08-23T23:30:00.000Z'),
        }];
      },
    } as unknown as PrismaClient;

    const result = await new PrismaResourceMetricSummaryReader(prisma).listFast('tenant-1', {
      statistic: 'MEAN',
      limit: 100,
    });

    expect(queryCalls).toBe(1);
    expect(result).toEqual([expect.objectContaining({
      provider: 'OCI',
      externalResourceId: 'ocid1.instance.example',
      cloudResourceId: 'resource-1',
      metricName: 'CpuUtilization',
      sampleCount: 48,
      coverageDays: 2,
      min: 3,
      max: 91,
      avg: 22.5,
      latest: 18,
    })]);
  });
});
