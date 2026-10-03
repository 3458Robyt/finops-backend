import { describe, expect, it } from 'vitest';
import { normalizeMetricDefinition } from './CloudConnectionInputPolicy.js';

describe('AWS metric statistic normalization', () => {
  it('converts the legacy CloudWatch stat field into coverage statistics', () => {
    const definition = normalizeMetricDefinition('aws', {
      externalResourceId: 'i-123',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      stat: 'Maximum',
      dimensions: [{ Name: 'InstanceId', Value: 'i-123' }],
    }, 0);

    expect(definition).toMatchObject({ statistics: ['MAX'] });
    expect(definition).not.toHaveProperty('stat');
  });

  it('normalizes CloudWatch aliases and removes duplicate statistics', () => {
    const definition = normalizeMetricDefinition('aws', {
      externalResourceId: 'i-123',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      statistics: ['MEAN', 'Maximum', 'p95', 'MEAN'],
      dimensions: [{ Name: 'InstanceId', Value: 'i-123' }],
    }, 0);

    expect(definition['statistics']).toEqual(['MEAN', 'MAX', 'P95']);
  });
});
