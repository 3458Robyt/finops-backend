import { describe, expect, it } from 'vitest';
import { isFocusObjectName, readFocusSourcePreviewConfig } from './focusSourcePreview.js';

describe('readFocusSourcePreviewConfig', () => {
  it('reads AWS configured objects and prefix locations', () => {
    const config = readFocusSourcePreviewConfig('aws', {
      awsFocusExportObjects: [
        { bucket: 'billing', key: 'exports/report.csv.gz', region: 'us-east-1' },
      ],
      awsFocusExportLocations: [
        { bucket: 'billing', prefix: 'exports/focus/', maxObjects: 50 },
      ],
    });

    expect(config.configuredObjects).toEqual([
      {
        provider: 'aws',
        source: 'configured',
        bucket: 'billing',
        key: 'exports/report.csv.gz',
        region: 'us-east-1',
        focusVersion: '1.0',
      },
    ]);
    expect(config.locations).toEqual([
      {
        provider: 'aws',
        bucket: 'billing',
        prefix: 'exports/focus/',
        focusVersion: '1.0',
        maxObjects: 50,
      },
    ]);
  });

  it('reads OCI configured objects and clamps location limits', () => {
    const config = readFocusSourcePreviewConfig('oci', {
      ociFocusReportObjects: [
        {
          namespaceName: 'namespace',
          bucketName: 'billing',
          objectName: 'reports/report.csv',
          focusVersion: '1.0',
        },
      ],
      ociFocusReportLocations: [
        {
          namespaceName: 'namespace',
          bucketName: 'billing',
          prefix: 'reports/',
          maxObjects: 2000,
        },
      ],
    });

    expect(config.configuredObjects).toHaveLength(1);
    expect(config.locations[0]).toMatchObject({ maxObjects: 1000 });
  });

  it('recognizes supported FOCUS object names only', () => {
    expect(isFocusObjectName('report.csv')).toBe(true);
    expect(isFocusObjectName('report.csv.gz')).toBe(true);
    expect(isFocusObjectName('manifest.json')).toBe(false);
  });
});
