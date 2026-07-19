import { describe, expect, it } from 'vitest';
import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedFocusCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { AwsSdkIngestionProvider } from './AwsSdkIngestionProvider.js';

describe('AwsSdkIngestionProvider', () => {
  it('reports every capability as not configured without exposing credentials', async () => {
    const result = await new AwsSdkIngestionProvider().validate({
      id: 'connection_1', tenantId: 'tenant_1', providerCode: 'aws',
      rootExternalId: '123456789012', defaultRegion: 'us-east-1', credentials: [],
    });

    expect(result.capabilities).toHaveLength(5);
    expect(result.capabilities.every((item) => item.status === 'NOT_CONFIGURED')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|privateKey|externalId/i);
  });

  it('collects EC2 inventory resources through the AWS SDK', async () => {
    const provider = new AwsSdkIngestionProvider();
    Object.assign(provider as unknown as {
      assumeRole: () => Promise<unknown>;
      createEc2Client: () => unknown;
    }, {
      assumeRole: async () => ({ accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test' }),
      createEc2Client: () => ({
        send: async () => ({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-0123456789abcdef0',
                  InstanceType: 't3.micro',
                  State: { Name: 'running' },
                  Tags: [{ Key: 'Name', Value: 'api-prod' }],
                },
              ],
            },
          ],
        }),
      }),
    });

    const result = await provider.collect({
      ...buildMetricJob(),
      sourceType: 'INVENTORY',
    });

    expect(result.resources).toEqual([
      expect.objectContaining({
        provider: 'AWS',
        externalResourceId: 'i-0123456789abcdef0',
        name: 'api-prod',
        resourceType: 'COMPUTE_INSTANCE',
        serviceName: 'Amazon EC2',
        status: 'ACTIVE',
      }),
    ]);
    expect(result.coverage).toMatchObject({ inventorySource: 'aws_ec2_sdk_with_metadata_fallback' });
  });

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

  it('discovers and parses AWS FOCUS exports from S3 prefixes', async () => {
    const provider = new AwsSdkIngestionProvider();
    const commands: string[] = [];

    Object.assign(provider as unknown as {
      assumeRole: () => Promise<unknown>;
      createS3Client: () => unknown;
    }, {
      assumeRole: async () => ({
        accessKeyId: 'test',
        secretAccessKey: 'test',
        sessionToken: 'test',
      }),
      createS3Client: () => ({
        send: async (command: { readonly constructor?: { readonly name?: string } }) => {
          commands.push(command.constructor?.name ?? 'UnknownCommand');
          if (command.constructor?.name === 'ListObjectsV2Command') {
            return {
              Contents: [
                { Key: 'exports/focus/2026-06/report.csv' },
                { Key: 'exports/focus/2026-06/readme.txt' },
              ],
              IsTruncated: false,
            };
          }

          return {
            Body: Buffer.from(buildFocusCsv(), 'utf8'),
          };
        },
      }),
    });

    const result = await provider.collect(buildAwsFocusJob());
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(commands).toEqual(['ListObjectsV2Command', 'GetObjectCommand']);
    expect(result.objectsProcessed).toBe(1);
    expect(result.focusRows).toHaveLength(0);
    expect(focusRows).toHaveLength(1);
    expect(focusRows[0]).toMatchObject({
      provider: 'AWS',
      serviceName: 'AmazonEC2',
      resourceId: 'i-0123456789abcdef0',
      billedCost: 12.5,
      consumedQuantity: 4,
      consumedUnit: 'Hours',
    });
    expect(result.coverage).toMatchObject({
      objectsDiscovered: 1,
      rowsParsed: 'streamed',
    });
    expect(result.warnings).toEqual([]);
  });
});

async function collectFocusRows(
  batches: CloudIngestionResult['focusBatches'],
): Promise<NormalizedFocusCostLineItem[]> {
  const rows: NormalizedFocusCostLineItem[] = [];
  if (batches === undefined) {
    return rows;
  }

  for await (const batch of batches) {
    rows.push(...batch);
  }

  return rows;
}

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

function buildAwsFocusJob(): CloudIngestionJobContext {
  return {
    id: 'job_2',
    tenantId: 'tenant_1',
    cloudConnectionId: 'connection_1',
    sourceType: 'BILLING_EXPORT',
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
          },
        },
      ],
      metadata: {
        awsFocusExportLocations: [
          {
            bucket: 'finops-billing',
            prefix: 'exports/focus/',
            region: 'us-east-1',
            focusVersion: '1.0',
            maxObjects: 10,
          },
        ],
      },
    },
  };
}

function buildFocusCsv(): string {
  return [
    [
      'BilledCost',
      'BillingCurrency',
      'BillingAccountId',
      'ChargeCategory',
      'ChargePeriodStart',
      'ChargePeriodEnd',
      'ConsumedQuantity',
      'ConsumedUnit',
      'EffectiveCost',
      'ListCost',
      'ProviderName',
      'RegionId',
      'ResourceId',
      'ServiceName',
      'SubAccountId',
    ].join(','),
    [
      '12.5',
      'USD',
      'payer-1',
      'Usage',
      '2026-06-01 00:00:00',
      '2026-06-01 01:00:00',
      '4',
      'Hours',
      '10',
      '15',
      'Amazon Web Services',
      'us-east-1',
      'i-0123456789abcdef0',
      'AmazonEC2',
      'linked-1',
    ].join(','),
  ].join('\n');
}
