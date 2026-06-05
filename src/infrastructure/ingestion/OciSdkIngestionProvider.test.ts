import { describe, expect, it } from 'vitest';
import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';
import { OciSdkIngestionProvider } from './OciSdkIngestionProvider.js';

describe('OciSdkIngestionProvider', () => {
  it('normalizes metric samples from OCI TypeScript SDK items response', async () => {
    const provider = new OciSdkIngestionProvider();
    const requests: unknown[] = [];

    Object.assign(provider as unknown as { createMonitoringClient: () => unknown }, {
      createMonitoringClient: () => ({
        summarizeMetricsData: async (request: unknown) => {
          requests.push(request);
          return {
            items: [
              {
                namespace: 'oci_computeagent',
                name: 'CpuUtilization',
                dimensions: { resourceId: 'ocid1.instance.oc1.test' },
                aggregatedDatapoints: [
                  { timestamp: new Date('2026-06-04T01:30:00Z'), value: 4.2 },
                ],
              },
            ],
          };
        },
      }),
    });

    const result = await provider.collect(buildMetricJob());

    expect(requests).toHaveLength(1);
    expect(result.metricSamples).toEqual([
      expect.objectContaining({
        provider: 'OCI',
        externalResourceId: 'ocid1.instance.oc1.test',
        metricName: 'CpuUtilization',
        value: 4.2,
        granularitySeconds: 1800,
      }),
    ]);
    expect(result.warnings).toEqual([]);
  });
});

function buildMetricJob(): CloudIngestionJobContext {
  return {
    id: 'job_1',
    tenantId: 'tenant_1',
    cloudConnectionId: 'connection_1',
    sourceType: 'TECHNICAL_METRIC',
    targetStart: new Date('2026-06-04T01:30:00Z'),
    targetEnd: new Date('2026-06-04T02:00:00Z'),
    connection: {
      id: 'connection_1',
      tenantId: 'tenant_1',
      providerCode: 'oci',
      rootExternalId: 'ocid1.tenancy.oc1.test',
      credentials: [],
      metadata: {
        ociMetricDefinitions: [
          {
            compartmentId: 'ocid1.tenancy.oc1.test',
            namespace: 'oci_computeagent',
            metricName: 'CpuUtilization',
            resourceId: 'ocid1.instance.oc1.test',
          },
        ],
      },
    },
  };
}
