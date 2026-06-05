import { describe, expect, it } from 'vitest';
import { configureFocusSourceMetadata } from './focusSourceMetadata.js';

describe('configureFocusSourceMetadata', () => {
  it('appends OCI FOCUS prefix locations without losing existing metadata', () => {
    const result = configureFocusSourceMetadata({
      provider: 'oci',
      mode: 'location',
      replace: false,
      existingMetadata: {
        ociMetricDefinitions: [{ metricName: 'CpuUtilization' }],
      },
      values: new Map([
        ['namespace-name', 'tenantnamespace'],
        ['bucket-name', 'finops-billing'],
        ['prefix', 'reports/focus/'],
        ['focus-version', '1.0'],
        ['max-objects', '25'],
      ]),
    });

    expect(result.updatedKey).toBe('ociFocusReportLocations');
    expect(result.configuredCount).toBe(1);
    expect(result.metadata).toMatchObject({
      ociMetricDefinitions: [{ metricName: 'CpuUtilization' }],
      ociFocusReportLocations: [
        {
          namespaceName: 'tenantnamespace',
          bucketName: 'finops-billing',
          prefix: 'reports/focus/',
          focusVersion: '1.0',
          maxObjects: 25,
        },
      ],
    });
  });

  it('replaces AWS FOCUS objects when requested', () => {
    const result = configureFocusSourceMetadata({
      provider: 'aws',
      mode: 'object',
      replace: true,
      existingMetadata: {
        awsFocusExportObjects: [{ bucket: 'old', key: 'old.csv', focusVersion: '1.0' }],
      },
      values: new Map([
        ['bucket', 'finops-billing'],
        ['key', 'exports/focus/report.csv.gz'],
        ['region', 'us-east-1'],
      ]),
    });

    expect(result.updatedKey).toBe('awsFocusExportObjects');
    expect(result.configuredCount).toBe(1);
    expect(result.metadata).toMatchObject({
      awsFocusExportObjects: [
        {
          bucket: 'finops-billing',
          key: 'exports/focus/report.csv.gz',
          region: 'us-east-1',
          focusVersion: '1.0',
        },
      ],
    });
  });

  it('rejects missing provider-specific required values', () => {
    expect(() => configureFocusSourceMetadata({
      provider: 'oci',
      mode: 'object',
      replace: false,
      existingMetadata: {},
      values: new Map([
        ['namespace-name', 'tenantnamespace'],
        ['bucket-name', 'finops-billing'],
      ]),
    })).toThrow('Missing required --object-name');
  });
});
