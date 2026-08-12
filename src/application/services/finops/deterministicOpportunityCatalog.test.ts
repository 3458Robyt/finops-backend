import { describe, expect, it } from 'vitest';
import type { ResourceLinkageReadiness } from '../../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import { buildDeterministicOpportunityCatalog } from './deterministicOpportunityCatalog.js';

function readiness(overrides: Partial<ResourceLinkageReadiness> = {}): ResourceLinkageReadiness {
  const generatedAt = new Date('2026-08-12T12:00:00.000Z');
  const coverage = { total: 10, eligible: 10, linked: 8, notEligible: 0, unresolved: 2, ambiguous: 1, coveragePercent: 80, reasons: {} };
  const freshness = {
    inventory: { status: 'FRESH' as const, observedAt: generatedAt },
    costs: { status: 'FRESH' as const, observedAt: generatedAt },
    metrics: { status: 'FRESH' as const, observedAt: generatedAt },
  };
  return {
    generatedAt,
    status: 'PARTIAL',
    inventoryResources: 2,
    linkedResourcesWithCost: 1,
    linkedResourcesWithMetrics: 1,
    linkedResourcesWithBoth: 1,
    costs: coverage,
    costClassifications: {
      counts: {
        RESOURCE_FOUND: 8, HISTORICAL_RESOURCE: 0, SERVICE_OR_ACCOUNT_LEVEL: 0,
        CONNECTION_NOT_AVAILABLE: 0, INVALID_OR_UNSUPPORTED_ID: 0,
        INVENTORY_RESOURCE_NOT_FOUND: 2, AMBIGUOUS_RESOURCE_ID: 0,
      },
      byService: [],
    },
    metrics: { ...coverage, unresolved: 0, ambiguous: 0 },
    recommendations: { ...coverage, unresolved: 0, ambiguous: 0 },
    resources: [],
    connections: [],
    tagGovernance: {
      requiredKeys: ['environment', 'owner'], totalResources: 2, taggedResources: 1,
      compliantResources: 1, nonCompliantResources: 1, untaggedResources: 1,
      coveragePercent: 50, missingKeys: { environment: 1 },
    },
    freshness,
    technicalRecommendationBlockers: ['UNLINKED_COST_EVIDENCE'],
    ...overrides,
  };
}

describe('buildDeterministicOpportunityCatalog', () => {
  it('builds auditable opportunities from linkage and governance evidence without savings claims', () => {
    const catalog = buildDeterministicOpportunityCatalog(readiness());
    const ids = catalog.opportunities.map((item) => item.id);

    expect(catalog.ruleVersion).toBe('finops-opportunity-rules-v1');
    expect(catalog.resourceCoverageComplete).toBe(false);
    expect(ids).toContain('blocker:UNLINKED_COST_EVIDENCE');
    expect(ids).toContain('coverage:costs:unresolved');
    expect(ids).toContain('tags:missing:environment');
    expect(catalog.opportunities.every((item) => item.evidence.source === 'RESOURCE_LINKAGE_READINESS')).toBe(true);
    expect(catalog.opportunities.every((item) => !('estimatedMonthlySavings' in item))).toBe(true);
  });

  it('marks weak resource evidence and makes the resource sample explicit', () => {
    const catalog = buildDeterministicOpportunityCatalog(readiness({
      inventoryResources: 3,
      resources: [{
        id: 'resource-1', cloudConnectionId: 'connection-1', externalResourceId: 'ocid1.instance.1',
        provider: 'OCI', serviceName: 'Compute', resourceType: 'instance', status: 'ACTIVE',
        costMetrics: 12, metricSamples: 0, recommendations: 0, coverage: 'COST_ONLY',
        evidenceStatus: 'COST_ONLY', freshness: {
          inventory: { status: 'FRESH' }, costs: { status: 'FRESH' }, metrics: { status: 'NO_DATA' },
        },
      }],
      technicalRecommendationBlockers: [],
    }));
    const resourceOpportunity = catalog.opportunities.find((item) => item.resourceId === 'resource-1');

    expect(catalog.resourceCoverageComplete).toBe(false);
    expect(resourceOpportunity?.kind).toBe('TECHNICAL_EVIDENCE');
    expect(resourceOpportunity?.evidence.signals).toContainEqual({ key: 'metricSamples', value: 0 });
  });

  it('produces stable identifiers and ordering for the same readiness snapshot', () => {
    const first = buildDeterministicOpportunityCatalog(readiness());
    const second = buildDeterministicOpportunityCatalog(readiness());

    expect(second.opportunities.map((item) => item.id)).toEqual(first.opportunities.map((item) => item.id));
    expect(second.opportunities.map((item) => item.priority)).toEqual(first.opportunities.map((item) => item.priority));
  });
});
