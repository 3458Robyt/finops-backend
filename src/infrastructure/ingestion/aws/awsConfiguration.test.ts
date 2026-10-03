import { describe, expect, it } from 'vitest';
import type { CloudIngestionJobContext } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { readAwsFocusLocations, readAwsFocusObjects, readAwsMetricDefinitions } from './awsConfiguration.js';

function job(metadata: Readonly<Record<string, unknown>>): CloudIngestionJobContext {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    sourceType: 'BILLING_EXPORT',
    targetStart: new Date('2026-01-01T00:00:00Z'),
    targetEnd: new Date('2026-02-01T00:00:00Z'),
    attempt: 1,
    connection: {
      id: 'connection-1',
      tenantId: 'tenant-1',
      providerCode: 'aws',
      rootExternalId: '653935120201',
      metadata,
      credentials: [],
    },
  };
}

describe('AWS FOCUS export configuration', () => {
  it('defaults AWS export locations and objects to FOCUS 1.2', () => {
    const context = job({
      awsFocusExportLocations: [{ bucket: 'finops-billing', prefix: 'exports/' }],
      awsFocusExportObjects: [{ bucket: 'finops-billing', key: 'exports/costs.csv.gz' }],
    });

    expect(readAwsFocusLocations(context)[0]?.focusVersion).toBe('1.2');
    expect(readAwsFocusObjects(context)[0]?.focusVersion).toBe('1.2');
  });

  it('preserves an explicitly configured legacy FOCUS version', () => {
    const context = job({
      awsFocusExportLocations: [{ bucket: 'finops-billing', prefix: 'exports/', focusVersion: '1.0' }],
      awsFocusExportObjects: [{ bucket: 'finops-billing', key: 'exports/costs.csv.gz', focusVersion: '1.0' }],
    });

    expect(readAwsFocusLocations(context)[0]?.focusVersion).toBe('1.0');
    expect(readAwsFocusObjects(context)[0]?.focusVersion).toBe('1.0');
  });
});

describe('AWS metric definition configuration', () => {
  it('expands native CloudWatch statistics from the saved discovery selection', () => {
    const definitions = readAwsMetricDefinitions({
      ...job({}), sourceType: 'TECHNICAL_METRIC',
      connection: { ...job({}).connection, metadata: { awsMetricDefinitions: [{
        externalResourceId: 'i-abcd', namespace: 'AWS/EC2', metricName: 'CPUUtilization',
        dimensions: [{ Name: 'InstanceId', Value: 'i-abcd' }], statistics: ['MEAN', 'MAX'],
      }] } },
    });
    expect(definitions.map((item) => item.stat)).toEqual(['Average', 'Maximum']);
  });
});
