import { describe, expect, it, vi } from 'vitest';
import type { CloudIngestionConnection } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { discoverAwsMetricDefinitions } from './AwsMetricDiscovery.js';
import { normalizeAwsStatistic } from './AwsMetricCollector.js';

describe('normalizeAwsStatistic', () => {
  it.each([
    ['Average', 'MEAN'], ['Minimum', 'MIN'], ['Maximum', 'MAX'],
    ['Sum', 'SUM'], ['SampleCount', 'COUNT'], ['p95', 'P95'],
  ])('maps supported CloudWatch statistic %s to %s', (input, expected) => {
    expect(normalizeAwsStatistic(input)).toBe(expected);
  });

  it('does not silently classify unknown provider statistics as an average', () => {
    expect(() => normalizeAwsStatistic('typo-stat')).toThrow(/estadística no soportada/i);
  });
});

describe('discoverAwsMetricDefinitions', () => {
  it('returns only resource-addressable CloudWatch definitions and closes the client', async () => {
    const send = vi.fn(async () => ({ Metrics: [{
      Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Unit: 'Percent',
      Dimensions: [{ Name: 'InstanceId', Value: 'i-abcd' }],
    }, {
      Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Unit: 'Percent',
      Dimensions: [{ Name: 'AutoScalingGroupName', Value: 'web-fleet' }],
    }] }));
    const destroy = vi.fn();
    const connection: CloudIngestionConnection = {
      id: 'conn', tenantId: 'tenant', providerCode: 'aws', rootExternalId: '123456789012',
      credentials: [{ purpose: 'OPERATIONAL', payload: { roleArn: 'arn:aws:iam::123456789012:role/read', externalId: 'external' } }],
      metadata: { awsMetricDiscoveryNamespaces: ['AWS/EC2'], awsMetricDiscoveryNames: ['CPUUtilization'] },
    };
    const result = await discoverAwsMetricDefinitions(connection, {
      regionId: 'us-east-1', compartmentId: connection.rootExternalId,
    }, {
      assumeRole: vi.fn(async () => ({ accessKeyId: 'temp', secretAccessKey: 'temp', sessionToken: 'temp' })),
      createClient: vi.fn(() => ({ send, destroy })),
    });

    expect(result.definitions).toEqual([expect.objectContaining({
      compartmentId: '123456789012', namespace: 'AWS/EC2', metricName: 'CPUUtilization',
      resourceId: 'i-abcd', regionId: 'us-east-1', unit: 'Percent', statistics: ['MEAN'],
    })]);
    expect(result.apiCallCount).toBe(1);
    expect(result.warnings).toContain('Se omitieron 1 series CloudWatch sin una dimensión de recurso reconocible; no pueden configurarse de forma segura por recurso.');
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('honors cancellation before issuing another CloudWatch call', async () => {
    const controller = new AbortController(); controller.abort();
    const send = vi.fn();
    const connection: CloudIngestionConnection = {
      id: 'conn', tenantId: 'tenant', providerCode: 'aws', rootExternalId: '123456789012',
      credentials: [{ purpose: 'OPERATIONAL', payload: { roleArn: 'role' } }],
    };
    await expect(discoverAwsMetricDefinitions(connection, { regionId: 'us-east-1', compartmentId: '' }, {
      assumeRole: async () => ({ accessKeyId: 'temp', secretAccessKey: 'temp', sessionToken: 'temp' }),
      createClient: () => ({ send }),
    }, controller.signal)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
