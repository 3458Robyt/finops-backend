import { describe, expect, test } from 'vitest';

import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
  TechnicalCostContextItem,
  TechnicalMetricCoverageFilters,
  TechnicalMetricCoverageSampleItem,
  TechnicalMetricSampleFilters,
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryResult,
  TechnicalMetricSummaryFilters,
  TechnicalMetricSummaryItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import { TechnicalRecommendationEvidenceService } from './TechnicalRecommendationEvidenceService.js';

class FakeResourceMetricRepository implements IResourceMetricRepository {
  public samples: readonly ResourceMetricSampleItem[] = [];
  public costContext: readonly TechnicalCostContextItem[] = [];
  public summaries: readonly TechnicalMetricSummaryItem[] = [];

  public async listResourcesForTenant(): Promise<readonly CloudResourceItem[]> {
    return [];
  }

  public async listMetricSamplesForTenant(): Promise<readonly ResourceMetricSampleItem[]> {
    return this.samples;
  }

  public async listMetricSamplesForTenantByFilter(
    _tenantId: string,
    _filters: TechnicalMetricSampleFilters,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    return this.samples;
  }

  public async listMetricSeriesForTenant(
    _tenantId: string,
    _filters: TechnicalMetricSeriesFilters,
  ): Promise<TechnicalMetricSeriesRepositoryResult> {
    return { points: [], totalSamples: 0, hasMore: false };
  }

  public async listMetricCoverageSamplesForTenant(
    _tenantId: string,
    _filters: TechnicalMetricCoverageFilters,
  ): Promise<readonly TechnicalMetricCoverageSampleItem[]> {
    return [];
  }

  public async listCostContextForResources(
    _tenantId: string,
    _externalResourceIds: readonly string[],
  ): Promise<readonly TechnicalCostContextItem[]> {
    return this.costContext;
  }

  public async listMetricSummariesForTenant(
    _tenantId: string,
    _filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    return this.summaries;
  }
}

describe('TechnicalRecommendationEvidenceService', () => {
  test('builds compact technical evidence with metric references', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.samples = [
      sample('s1', 8, '2026-06-20T00:00:00.000Z'),
      sample('s2', 12, '2026-06-21T00:00:00.000Z'),
    ];
    repository.costContext = [
      { externalResourceId: 'ocid1.instance.oc1.test', totalCost: 42, currency: 'USD', metricCount: 2 },
    ];
    repository.summaries = [
      metricSummary('CpuUtilization', 8, 25),
      metricSummary('MemoryUtilization', 22, 42),
    ];

    const service = new TechnicalRecommendationEvidenceService(repository);
    const evidence = await service.buildRecommendationEvidence({
      tenantId: 'tenant-1',
      snapshot,
    });

    expect(evidence).toContain('COST_USAGE_AND_TECHNICAL_AVAILABLE');
    expect(evidence).toContain('resource_metric_samples:ocid1.instance.oc1.test:CpuUtilization');
    expect(evidence).toContain('"technicalEvidenceRefs"');
    expect(evidence).toContain('"deterministicRules"');
    expect(evidence).toContain('CPU_STRONG_UNDERUTILIZATION');
    expect(evidence).toContain('"totalCost":42');
  });

  test('warns the model when no technical samples exist', async () => {
    const service = new TechnicalRecommendationEvidenceService(new FakeResourceMetricRepository());

    const evidence = await service.buildRecommendationEvidence({
      tenantId: 'tenant-1',
      snapshot,
    });

    expect(evidence).toContain('NO_TECHNICAL_EVIDENCE');
    expect(evidence).toContain('requiresTechnicalValidation=true');
  });
});

const snapshot: CostAnalyticsSnapshot = {
  tenantId: 'tenant-1',
  periodStart: '2026-06-01T00:00:00.000Z',
  periodEnd: '2026-06-30T23:59:59.000Z',
  totalCost: 100,
  currency: 'USD',
  metricCount: 10,
  providers: [],
  accounts: [],
  services: [],
  environments: [],
  topResources: [],
};

function sample(id: string, value: number, sampledAt: string): ResourceMetricSampleItem {
  return {
    id,
    provider: 'OCI',
    externalResourceId: 'ocid1.instance.oc1.test',
    cloudResourceId: 'cloud-resource-1',
    metricName: 'CpuUtilization',
    metricUnit: 'Percent',
    value,
    sampledAt: new Date(sampledAt),
    granularitySeconds: 1800,
  };
}

function metricSummary(metricName: string, avg: number, p95: number): TechnicalMetricSummaryItem {
  return {
    provider: 'OCI',
    externalResourceId: 'ocid1.instance.oc1.test',
    cloudResourceId: 'cloud-resource-1',
    resourceType: 'COMPUTE_INSTANCE',
    serviceName: 'Compute',
    metricName,
    metricUnit: 'Percent',
    sampleCount: 96,
    coverageDays: 14,
    min: 1,
    max: 50,
    avg,
    p50: avg,
    p95,
    p99: p95 + 5,
    latest: avg,
    firstSampledAt: new Date('2026-06-16T00:00:00.000Z'),
    latestSampledAt: new Date('2026-06-29T00:00:00.000Z'),
  };
}
