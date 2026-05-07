import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildOciCostMetricIdentityHash,
  buildOciFocusLineHash,
  parseOciFocusCsvText,
  parseOciFocusReportFile,
} from './ociFocusReport.js';

const header = [
  'AvailabilityZone',
  'BilledCost',
  'BillingAccountId',
  'BillingAccountName',
  'BillingCurrency',
  'BillingPeriodEnd',
  'BillingPeriodStart',
  'ChargeCategory',
  'ChargeDescription',
  'ChargeFrequency',
  'ChargePeriodEnd',
  'ChargePeriodStart',
  'ChargeSubcategory',
  'EffectiveCost',
  'ListCost',
  'PricingQuantity',
  'PricingUnit',
  'Provider',
  'Region',
  'ResourceId',
  'ResourceName',
  'ResourceType',
  'ServiceCategory',
  'ServiceName',
  'SubAccountId',
  'SubAccountName',
  'Tags',
  'UsageQuantity',
  'UsageUnit',
  'oci_ReferenceNumber',
  'oci_CompartmentId',
  'oci_CompartmentName',
].join(',');

const row = [
  '',
  '0.125',
  'ocid1.tenancy.oc1..root',
  'Personal tenancy',
  'USD',
  '2026-05-01T00:00Z',
  '2026-04-01T00:00Z',
  'Usage',
  'Compute Standard E4',
  'Usage-Based',
  '2026-05-01T01:00Z',
  '2026-05-01T00:00Z',
  'OnDemand',
  '0.125',
  '0.200',
  '1',
  'OCPU hour',
  'Oracle Cloud Infrastructure',
  'sa-bogota-1',
  'ocid1.instance.oc1.sa-bogota-1.example',
  'demo-vm',
  'ComputeInstance',
  'Compute',
  'COMPUTE',
  'ocid1.compartment.oc1..demo',
  'Demo compartment',
  '"{""environment"":""personal"",""owner"":""david""}"',
  '1',
  'OCPU hour',
  '0001000001091847',
  'ocid1.compartment.oc1..demo',
  'Demo compartment',
].join(',');

describe('OCI FOCUS report parser', () => {
  it('maps real OCI FOCUS fields into normalized rows', () => {
    const result = parseOciFocusCsvText(`${header}\n${row}\n`);
    const parsed = result.rows[0];

    expect(result.rawRowCount).toBe(1);
    expect(result.skippedRowCount).toBe(0);
    expect(parsed).toBeDefined();
    expect(parsed?.provider).toBe('OCI');
    expect(parsed?.serviceName).toBe('COMPUTE');
    expect(parsed?.resourceName).toBe('demo-vm');
    expect(parsed?.regionId).toBe('sa-bogota-1');
    expect(parsed?.billedCost).toBe(0.125);
    expect(parsed?.usageQuantity).toBe(1);
    expect(parsed?.usageUnit).toBe('OCPU hour');
    expect(parsed?.pricingQuantity).toBe(1);
    expect(parsed?.pricingUnit).toBe('OCPU hour');
    expect(parsed?.tags).toEqual({ environment: 'personal', owner: 'david' });
    expect(parsed?.oci['oci_ReferenceNumber']).toBe('0001000001091847');
  });

  it('builds stable natural hashes for duplicate billing rows', () => {
    const result = parseOciFocusCsvText(`${header}\n${row}\n`);
    const parsed = result.rows[0];

    expect(parsed).toBeDefined();

    const lineHash = buildOciFocusLineHash(parsed!);
    const sameLineHash = buildOciFocusLineHash(parsed!);
    const metricHash = buildOciCostMetricIdentityHash({
      tenantId: 'tenant-a',
      cloudAccountId: 'account-a',
      lineItemHash: lineHash,
    });

    expect(lineHash).toBe(sameLineHash);
    expect(metricHash).toHaveLength(64);
  });

  it('reads gzipped CSV reports', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'oci-focus-'));
    const filePath = path.join(directory, 'report.csv.gz');

    try {
      await writeFile(filePath, gzipSync(`${header}\n${row}\n`));

      const result = await parseOciFocusReportFile(filePath);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.serviceName).toBe('COMPUTE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
