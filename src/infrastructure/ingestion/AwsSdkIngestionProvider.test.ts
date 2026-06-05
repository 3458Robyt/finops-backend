import { describe, expect, it } from 'vitest';
import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';
import { AwsSdkIngestionProvider } from './AwsSdkIngestionProvider.js';

describe('AwsSdkIngestionProvider', () => {
  it('normalizes metric samples from CloudWatch GetMetricData results', async () => {
    const provider = new AwsSdkIngestionProvider();
    const requests: unknown[] = [];

    Object.assign(provider as unknown as {
      assumeRole: () => Promise<unknown>;
      createCloudWatchClient: () => unknown;
    }, {
      assumeRole: async () => ({
        accessKeyId: 'test',
        secretAccessKey: 'test',
        sessionToken: 'test',
      }),
      createCloudWatchClient: () => ({
        send: async (command: unknown) => {
          requests.push(command);
          return {
            MetricDataResults: [
              {
                Id: 'm0',
                Timestamps: [new Date('2026-06-04T01:30:00Z')],
                Values: [42],
              },
            ],
          };
        },
      }),
    });

    const result = await provider.collect(buildMetricJob());

    expect(requests).toHaveLength(1);
    expect(result.apiCallCount).toBe(2);
    expect(result.metricSamples).toEqual([
      expect.objectContaining({
        provider: 'AWS',
        externalResourceId: 'i-0123456789abcdef0',
        metricName: 'CPUUtilization',
        metricUnit: 'Percent',
        value: 42,
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
      providerCode: 'aws',
      rootExternalId: '123456789012',
      defaultRegion: 'us-east-1',
      credentials: [
        {
          purpose: 'OPERATIONAL',
          payload: {
            roleArn: 'arn:aws:iam::123456789012:role/FinOpsReadOnly',
            externalId: 'external-id',
          },
        },
      ],
      metadata: {
        awsMetricDefinitions: [
          {
            externalResourceId: 'i-0123456789abcdef0',
            namespace: 'AWS/EC2',
            metricName: 'CPUUtilization',
            stat: 'Average',
            unit: 'Percent',
            dimensions: [
              { Name: 'InstanceId', Value: 'i-0123456789abcdef0' },
            ],
          },
        ],
      },
    },
  };
}
