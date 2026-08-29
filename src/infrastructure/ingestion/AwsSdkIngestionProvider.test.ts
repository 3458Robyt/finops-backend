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
    expect(result.apiCallCount).toBe(4);
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

  it('preserves CloudWatch percentile and maximum statistics', async () => {
    const provider = new AwsSdkIngestionProvider();
    const baseJob = buildMetricJob();
    const job = {
      ...baseJob,
      connection: {
        ...baseJob.connection,
        metadata: {
          awsMetricDefinitions: [
            {
              externalResourceId: 'i-0123456789abcdef0',
              namespace: 'AWS/EC2',
              metricName: 'CPUUtilization',
              stat: 'p95',
              unit: 'Percent',
              dimensions: [{ Name: 'InstanceId', Value: 'i-0123456789abcdef0' }],
            },
            {
              externalResourceId: 'i-0123456789abcdef0',
              namespace: 'AWS/EC2',
              metricName: 'CPUUtilization',
              stat: 'Maximum',
              unit: 'Percent',
              dimensions: [{ Name: 'InstanceId', Value: 'i-0123456789abcdef0' }],
            },
          ],
        },
      },
    };

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
        send: async () => ({
          MetricDataResults: [
            { Id: 'm0', Timestamps: [new Date('2026-06-04T01:30:00Z')], Values: [95] },
            { Id: 'm1', Timestamps: [new Date('2026-06-04T01:30:00Z')], Values: [99] },
          ],
        }),
      }),
    });

    const result = await provider.collect(job);

    expect(result.metricSamples.map((sample) => sample.statistic)).toEqual(['P95', 'MAX']);
    expect(result.metricSamples.map((sample) => sample.rawMetric?.['statistic'])).toEqual(['P95', 'MAX']);
  });

  it('paginates CloudWatch metric data and exposes partial-series warnings', async () => {
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
          if (requests.length === 1) {
            return {
              MetricDataResults: [{
                Id: 'm0',
                StatusCode: 'PartialData',
                Messages: [{ Code: 'InternalError', Value: 'La serie se devolvió parcialmente.' }],
                Timestamps: [new Date('2026-06-04T01:30:00Z')],
                Values: [42],
              }],
              NextToken: 'page-2',
            };
          }

          return {
            MetricDataResults: [{
              Id: 'm0',
              Timestamps: [new Date('2026-06-04T02:00:00Z')],
              Values: [44],
            }],
          };
        },
      }),
    });

    const result = await provider.collect(buildMetricJob());

    expect(requests).toHaveLength(2);
    expect(result.apiCallCount).toBe(3);
    expect(result.metricSamples.map((sample) => sample.value)).toEqual([42, 44]);
    expect(result.warnings).toEqual([
      'CloudWatch devolvió PartialData para una serie m0 en us-east-1.',
      'CloudWatch: La serie se devolvió parcialmente.',
    ]);
  });

  it('discovers resource metrics from CloudWatch when definitions are not configured', async () => {
    const provider = new AwsSdkIngestionProvider();
    const job = {
      ...buildMetricJob(),
      connection: {
        ...buildMetricJob().connection,
        metadata: {
          awsMetricDiscoveryNamespaces: ['AWS/EC2'],
          awsMetricDiscoveryNames: ['CPUUtilization'],
          awsMetricDiscoveryStatistics: ['Average', 'Maximum'],
        },
      },
    };

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
        send: async (command: { readonly constructor?: { readonly name?: string } }) => {
          if (command.constructor?.name === 'ListMetricsCommand') {
            return {
              Metrics: [{
                Namespace: 'AWS/EC2',
                MetricName: 'CPUUtilization',
                Unit: 'Percent',
                Dimensions: [{ Name: 'InstanceId', Value: 'i-0123456789abcdef0' }],
              }],
            };
          }
          return {
            MetricDataResults: [
              { Id: 'm0', Timestamps: [new Date('2026-06-04T01:30:00Z')], Values: [42] },
              { Id: 'm1', Timestamps: [new Date('2026-06-04T01:30:00Z')], Values: [55] },
            ],
          };
        },
      }),
    });

    const result = await provider.collect(job);

    expect(result.apiCallCount).toBe(3);
    expect(result.metricSamples.map((sample) => sample.statistic)).toEqual(['MEAN', 'MAX']);
    expect(result.metricSamples.map((sample) => sample.value)).toEqual([42, 55]);
    expect(result.metricSamples.every((sample) => sample.externalResourceId === 'i-0123456789abcdef0')).toBe(true);
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

  it('uses AWS FOCUS manifests to discover split report files without duplicates', async () => {
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
          const name = command.constructor?.name ?? 'UnknownCommand';
          commands.push(name);
          if (name === 'ListObjectsV2Command') {
            return {
              Contents: [{ Key: 'exports/focus/2026-06/report-Manifest.json' }],
              IsTruncated: false,
            };
          }
          if (name === 'GetObjectCommand' && commands.length === 2) {
            return {
              Body: Buffer.from(JSON.stringify({
                reportKeys: ['exports/focus/2026-06/report-00001.csv'],
              }), 'utf8'),
            };
          }
          return { Body: Buffer.from(buildFocusCsv(), 'utf8') };
        },
      }),
    });

    const result = await provider.collect(buildAwsFocusJob());
    const focusRows = await collectFocusRows(result.focusBatches);

    expect(commands).toEqual(['ListObjectsV2Command', 'GetObjectCommand', 'GetObjectCommand']);
    expect(result.objectsProcessed).toBe(1);
    expect(focusRows).toHaveLength(1);
    expect(result.coverage).toMatchObject({ manifestsRead: 1 });
  });

  it('paginates Cost Explorer fallback and closes the SDK client', async () => {
    const provider = new AwsSdkIngestionProvider();
    let requests = 0;
    let destroyed = false;
    const baseJob = buildMetricJob();
    const job = {
      ...baseJob,
      sourceType: 'BILLING_EXPORT' as const,
      connection: {
        ...baseJob.connection,
        metadata: { billingSourceMode: 'PROVIDER_API' },
      },
    };

    Object.assign(provider as unknown as {
      assumeRole: () => Promise<unknown>;
      createCostExplorerClient: () => unknown;
    }, {
      assumeRole: async () => ({
        accessKeyId: 'test',
        secretAccessKey: 'test',
        sessionToken: 'test',
      }),
      createCostExplorerClient: () => ({
        send: async () => {
          requests += 1;
          return {
            ResultsByTime: [{
              TimePeriod: { Start: `2026-06-0${requests}`, End: `2026-06-0${requests + 1}` },
              Groups: [{
                Keys: [`AmazonEC2-${requests}`],
                Metrics: { UnblendedCost: { Amount: `${requests}.5`, Unit: 'USD' } },
              }],
            }],
            ...(requests === 1 ? { NextPageToken: 'page-2' } : {}),
          };
        },
        destroy: () => { destroyed = true; },
      }),
    });

    const result = await provider.collect(job);

    expect(requests).toBe(2);
    expect(destroyed).toBe(true);
    expect(result.apiCallCount).toBe(3);
    expect(result.providerCostRows).toHaveLength(2);
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
