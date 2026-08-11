import { describe, expect, test } from 'vitest';
import { buildCostLinkageCoverage } from './resourceLinkageCostQueries.js';

describe('buildCostLinkageCoverage', () => {
  test('uses only exact resource-level outcomes in the eligible denominator', () => {
    const result = buildCostLinkageCoverage([
      row('RESOURCE_FOUND', 80),
      row('HISTORICAL_RESOURCE', 10),
      row('INVENTORY_RESOURCE_NOT_FOUND', 5),
      row('AMBIGUOUS_RESOURCE_ID', 1),
      row('SERVICE_OR_ACCOUNT_LEVEL', 20),
      row('CONNECTION_NOT_AVAILABLE', 7),
      row('INVALID_OR_UNSUPPORTED_ID', 3),
    ]);

    expect(result.coverage).toMatchObject({
      total: 126,
      eligible: 96,
      linked: 90,
      notEligible: 30,
      unresolved: 6,
      ambiguous: 1,
      coveragePercent: 93.75,
    });
    expect(result.classifications.counts).toMatchObject({
      RESOURCE_FOUND: 80,
      HISTORICAL_RESOURCE: 10,
      SERVICE_OR_ACCOUNT_LEVEL: 20,
    });
  });
});

function row(classification: Parameters<typeof buildCostLinkageCoverage>[0][number]['classification'], count: number) {
  return { cloud_connection_id: 'connection-1', service_name: 'COMPUTE', classification, count: BigInt(count) };
}
