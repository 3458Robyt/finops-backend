import { describe, expect, test } from 'vitest';
import type {
  CloudIngestionJobContext,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import {
  buildHistoricalOciProviderResources,
  buildHistoricalOciResources,
  isOciAggregateResourceId,
} from './OciHistoricalResourceCatalog.js';

describe('buildHistoricalOciResources', () => {
  test('creates exact historical references only for supported OCI OCIDs', () => {
    const rows = [
      row('ocid1.bootvolume.oc1.test', 'BLOCK_STORAGE', '2026-05-01', '2026-05-02'),
      row('ocid1.bootvolume.oc1.test', 'BLOCK_STORAGE', '2026-05-02', '2026-05-03'),
      row('oci_computeagent', 'TELEMETRY', '2026-05-01', '2026-05-02'),
      row('', 'COMPUTE', '2026-05-01', '2026-05-02'),
    ];

    const resources = buildHistoricalOciResources(job(), rows);

    expect(resources).toEqual([
      expect.objectContaining({
        externalResourceId: 'ocid1.bootvolume.oc1.test',
        resourceType: 'BOOT_VOLUME',
        serviceName: 'Oracle Block Volume',
        status: 'UNKNOWN',
        firstSeenAt: new Date('2026-05-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-05-03T00:00:00.000Z'),
        rawResource: expect.objectContaining({
          source: 'OCI_FOCUS_HISTORICAL_REFERENCE',
          normalizerVersion: 'oci-focus-history-v1',
          historicalReference: true,
        }),
      }),
    ]);
  });

  test('creates UNKNOWN historical references for provider OCIDs but excludes logical and aggregate identifiers', () => {
    const resources = buildHistoricalOciProviderResources(job(), [
      providerRow('ocid1.instance.oc1.iad.example', 'Compute', 'us-ashburn-1'),
      providerRow('ocid1.instance.oc1.iad.example', 'Compute', 'us-ashburn-1', '2026-05-03'),
      providerRow('bucket-name', 'Object Storage', 'us-ashburn-1'),
      providerRow('oci_computeagent', 'Telemetry', 'us-ashburn-1'),
    ]);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toEqual(expect.objectContaining({
      externalResourceId: 'ocid1.instance.oc1.iad.example',
      resourceType: 'COMPUTE_INSTANCE',
      serviceName: 'Compute',
      regionId: 'us-ashburn-1',
      status: 'UNKNOWN',
      rawResource: expect.objectContaining({
        source: 'OCI_USAGE_API_HISTORICAL_REFERENCE',
        historicalReference: true,
      }),
    }));
    expect(isOciAggregateResourceId('oci_computeagent')).toBe(true);
  });
});

function job(): CloudIngestionJobContext {
  return {
    id: 'job-1', tenantId: 'tenant-1', cloudConnectionId: 'connection-1', sourceType: 'BILLING_EXPORT',
    targetStart: new Date('2026-05-01T00:00:00Z'), targetEnd: new Date('2026-05-04T00:00:00Z'),
    connection: { id: 'connection-1', tenantId: 'tenant-1', providerCode: 'oci', rootExternalId: 'tenancy-1', credentials: [] },
  };
}

function row(resourceId: string, serviceName: string, start: string, end: string): NormalizedFocusCostLineItem {
  return {
    tenantId: 'tenant-1', cloudConnectionId: 'connection-1', provider: 'OCI', focusVersion: '1.2',
    chargePeriodStart: new Date(`${start}T00:00:00Z`), chargePeriodEnd: new Date(`${end}T00:00:00Z`),
    serviceName, resourceId, chargeCategory: 'Usage', billedCost: 1, billingCurrency: 'USD',
    rawRow: { ResourceId: resourceId }, lineItemHash: `${resourceId}:${start}`,
  };
}

function providerRow(
  resourceId: string,
  serviceName: string,
  regionId: string,
  start = '2026-05-01',
): NormalizedProviderCostLineItem {
  return {
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    provider: 'OCI',
    chargePeriodStart: new Date(`${start}T00:00:00Z`),
    chargePeriodEnd: new Date(`${start}T01:00:00Z`),
    serviceName,
    resourceId,
    regionId,
    billedCost: 1,
    billingCurrency: 'USD',
    sourceMetric: 'OCIUsageCost',
    rawRow: { resourceId },
    lineItemHash: `${resourceId}:${start}`,
  };
}
