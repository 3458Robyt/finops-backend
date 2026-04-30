import { describe, expect, test } from 'vitest';
import { buildCostMetricSeedRows, parseFocusSampleCsv } from './focusSample.js';

const csv = `"AvailabilityZone","BilledCost","BillingAccountId","BillingAccountName","BillingCurrency","BillingPeriodEnd","BillingPeriodStart","ChargeCategory","ChargeClass","ChargeDescription","ChargeFrequency","ChargePeriodEnd","ChargePeriodStart","ConsumedQuantity","ConsumedUnit","EffectiveCost","ListCost","PricingQuantity","PricingUnit","ProviderName","RegionId","RegionName","ResourceId","ResourceName","ResourceType","ServiceCategory","ServiceName","SubAccountId","SubAccountName","Tags"
NULL,1.230000,"1234567890123","SunBird","USD","2024-10-01 00:00:00","2024-09-01 00:00:00","Usage",NULL,"EC2 compute","Usage-Based","2024-09-18 23:00:00","2024-09-18 22:00:00",2.000000,"Hours",1.230000,1.500000,2.000000,"Hours","AWS","us-west-2","US West (Oregon)","i-abc","prod-api","instance","Compute","Amazon Elastic Compute Cloud","51738928782","Atlas Nimbus","{""environment"": ""prod"", ""business_unit"": ""ViennaAI""}"
NULL,0.450000,"1234567890123","SunBird","USD","2024-10-01 00:00:00","2024-09-01 00:00:00","Usage",NULL,"RDS storage","Usage-Based","2024-09-19 23:00:00","2024-09-19 22:00:00",10.000000,"GB-Months",0.450000,0.500000,10.000000,"GB-Months","AWS","us-east-1","US East (N. Virginia)","db-abc","prod-db","database","Database","Amazon Relational Database Service","51738928782","Atlas Nimbus","{""environment"": ""prod"", ""business_unit"": ""ViennaAI""}"`;

describe('FOCUS sample seed helpers', () => {
  test('parses FOCUS CSV rows into typed records', () => {
    const rows = parseFocusSampleCsv(csv);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.serviceName).toBe('Amazon Elastic Compute Cloud');
    expect(rows[0]?.billedCost).toBe(1.23);
    expect(rows[0]?.tags).toEqual({
      environment: 'prod',
      business_unit: 'ViennaAI',
    });
  });

  test('maps parsed rows to Prisma cost metric create inputs', () => {
    const rows = buildCostMetricSeedRows({
      rows: parseFocusSampleCsv(csv),
      tenantId: 'tenant-1',
      cloudAccountId: 'account-1',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tenantId: 'tenant-1',
      cloudAccountId: 'account-1',
      provider: 'AWS',
      billingAccountId: '1234567890123',
      serviceName: 'Amazon Elastic Compute Cloud',
      resourceId: 'i-abc',
      billingCurrency: 'USD',
      tags: {
        environment: 'prod',
        business_unit: 'ViennaAI',
      },
    });
    expect(rows[0]?.metricIdentityHash).toHaveLength(64);
  });

  test('maps Oracle provider rows to OCI and ignores unsupported providers', () => {
    const oracleCsv = csv.replaceAll('"AWS"', '"Oracle"');
    const azureCsv = csv.replaceAll('"AWS"', '"Microsoft"');

    expect(parseFocusSampleCsv(oracleCsv)[0]?.providerName).toBe('OCI');
    expect(parseFocusSampleCsv(azureCsv)).toHaveLength(0);
  });
});
