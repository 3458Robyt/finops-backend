import { describe, expect, it } from 'vitest';
import { parseFocusCsvToLineItems } from './focusCsvIngestion.js';

const csv = [
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
    'Tags',
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
    'i-123',
    'AmazonEC2',
    'linked-1',
    '"{""env"":""prod""}"',
  ].join(','),
].join('\n');

describe('parseFocusCsvToLineItems', () => {
  it('normalizes FOCUS cost and usage rows for canonical ingestion', () => {
    const rows = parseFocusCsvToLineItems({
      tenantId: 'tenant-1',
      cloudConnectionId: 'connection-1',
      provider: 'AWS',
      focusVersion: '1.2',
      csvText: csv,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: 'tenant-1',
      cloudConnectionId: 'connection-1',
      provider: 'AWS',
      focusVersion: '1.2',
      billingAccountId: 'payer-1',
      subAccountId: 'linked-1',
      serviceName: 'AmazonEC2',
      resourceId: 'i-123',
      regionId: 'us-east-1',
      billedCost: 12.5,
      effectiveCost: 10,
      listCost: 15,
      consumedQuantity: 4,
      consumedUnit: 'Hours',
      billingCurrency: 'USD',
      tags: { env: 'prod' },
    });
  });

  it('keeps identity hash stable when mutable cost measures change', () => {
    const first = parseFocusCsvToLineItems({
      tenantId: 'tenant-1',
      cloudConnectionId: 'connection-1',
      provider: 'AWS',
      focusVersion: '1.2',
      csvText: csv,
    })[0]!;

    const correctedCsv = csv.replace('12.5,USD', '99,USD').replace(',4,Hours,10,15,', ',8,Hours,70,90,');
    const corrected = parseFocusCsvToLineItems({
      tenantId: 'tenant-1',
      cloudConnectionId: 'connection-1',
      provider: 'AWS',
      focusVersion: '1.2',
      csvText: correctedCsv,
    })[0]!;

    expect(corrected.billedCost).toBe(99);
    expect(corrected.consumedQuantity).toBe(8);
    expect(corrected.lineItemHash).toBe(first.lineItemHash);
  });
});
