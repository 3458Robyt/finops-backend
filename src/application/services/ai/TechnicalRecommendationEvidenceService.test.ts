import { describe, expect, test, vi } from 'vitest';

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
  public sampleFilters: TechnicalMetricSampleFilters | undefined;
  public summaryFilters: TechnicalMetricSummaryFilters | undefined;
  public fastSummaryFilters: TechnicalMetricSummaryFilters | undefined;

  public async listResourcesForTenant(): Promise<readonly CloudResourceItem[]> {
    return [];
  }

  public async listMetricSamplesForTenant(): Promise<readonly ResourceMetricSampleItem[]> {
    return this.samples;
  }

  public async listMetricSamplesForTenantByFilter(
    _tenantId: string,
    filters: TechnicalMetricSampleFilters,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    this.sampleFilters = filters;
    return this.samples.filter((sample) => (
      filters.externalResourceId === undefined || sample.externalResourceId === filters.externalResourceId
    ));
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
    filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    this.summaryFilters = filters;
    return this.summaries.filter((summary) => (
      filters.externalResourceIds === undefined || filters.externalResourceIds.includes(summary.externalResourceId)
    ));
  }

  public async listMetricSummariesForTenantFast(
    _tenantId: string,
    filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    this.fastSummaryFilters = filters;
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
      { externalResourceId: 'ocid1.instance.oc1..exampleid0017', cloudResourceId: 'cloud-resource-1', totalCost: 42, currency: 'USD', metricCount: 2 },
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
    expect(evidence).toContain('resource_metric_samples:cloud-resource-1:ocid1.instance.oc1..exampleid0017:CpuUtilization');
    expect(evidence).toContain('"technicalEvidenceRefs"');
    expect(evidence).toContain('"deterministicRules"');
    expect(evidence).toContain('CPU_STRONG_UNDERUTILIZATION');
    expect(evidence).toContain('"totalCost":42');
    expect(evidence).toContain('"hash"');
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

  test('limits technical evidence to the requested resource', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.samples = [
      sample('s1', 8, '2026-06-20T00:00:00.000Z'),
      { ...sample('s2', 55, '2026-06-20T00:00:00.000Z'), externalResourceId: 'ocid1.instance.oc1..exampleid0018' },
    ];
    repository.summaries = [
      metricSummary('CpuUtilization', 8, 25),
      { ...metricSummary('CpuUtilization', 55, 90), externalResourceId: 'ocid1.instance.oc1..exampleid0018' },
    ];
    const service = new TechnicalRecommendationEvidenceService(repository);

    const evidence = await service.buildRecommendationEvidence({
      tenantId: 'tenant-1',
      snapshot,
      externalResourceId: 'ocid1.instance.oc1..exampleid0017',
    });

    expect(repository.summaryFilters?.externalResourceIds).toEqual(['ocid1.instance.oc1..exampleid0017']);
    expect(evidence).toContain('ocid1.instance.oc1..exampleid0017');
    expect(evidence).not.toContain('ocid1.instance.oc1..exampleid0018');
  });

  test('limits tenant-wide evidence to resources present in the cost snapshot', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.summaries = [metricSummary('CpuUtilization', 8, 25)];
    const service = new TechnicalRecommendationEvidenceService(repository);

    await service.buildRecommendationEvidenceSnapshot({
      tenantId: 'tenant-1',
      snapshot: {
        ...snapshot,
        topResources: [{
          resourceId: 'ocid1.instance.oc1..exampleid0017',
          provider: 'OCI',
          serviceName: 'Compute',
          totalCost: 100,
          metricCount: 10,
        }],
      },
    });

    expect(repository.summaryFilters?.externalResourceIds).toEqual(['ocid1.instance.oc1..exampleid0017']);
  });

  test('does not treat a future monthly period end as stale technical evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T12:00:00.000Z'));
    try {
      const repository = new FakeResourceMetricRepository();
      repository.summaries = ['CpuUtilization', 'MemoryUtilization'].map((metricName) => ({
        ...metricSummary(metricName, 8, 25),
        firstSampledAt: new Date('2026-06-13T12:00:00.000Z'),
        latestSampledAt: new Date('2026-06-19T23:30:00.000Z'),
      }));
      const service = new TechnicalRecommendationEvidenceService(repository);

      const evidence = await service.buildRecommendationEvidenceSnapshot({
        tenantId: 'tenant-1',
        snapshot: {
          ...snapshot,
          periodStart: '2026-06-01T00:00:00.000Z',
          periodEnd: '2026-07-01T00:00:00.000Z',
        },
      });

      expect(evidence.deterministicRules[0]?.blockers).not.toContain('INSUFFICIENT_TECHNICAL_COVERAGE');
    } finally {
      vi.useRealTimers();
    }
  });

  test('uses bounded rollups for interactive chat evidence without changing exact recommendation evidence', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.summaries = [metricSummary('CpuUtilization', 8, 25)];
    const service = new TechnicalRecommendationEvidenceService(repository);

    await service.buildChatTechnicalEvidenceSnapshot({ tenantId: 'tenant-1', snapshot });

    expect(repository.fastSummaryFilters).toBeDefined();
    expect(repository.summaryFilters).toBeUndefined();

    await service.buildRecommendationEvidenceSnapshot({ tenantId: 'tenant-1', snapshot });

    expect(repository.summaryFilters).toBeDefined();
  });

  test('does not attribute service-wide usage to a resource and queries the current evidence window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T12:00:00.000Z'));
    try {
      const repository = new FakeResourceMetricRepository();
      repository.summaries = [metricSummary('CpuUtilization', 8, 25)];
      const service = new TechnicalRecommendationEvidenceService(repository);
      const evidence = await service.buildRecommendationEvidenceSnapshot({
        tenantId: 'tenant-1',
        snapshot: { ...snapshot, topResources: [{ resourceId: 'ocid1.instance.oc1..exampleid0017', provider: 'OCI', serviceName: 'Compute', totalCost: 42, metricCount: 2 }],
          topUsage: [{ serviceName: 'Compute', provider: 'OCI', consumedQuantity: 100, consumedUnit: 'Hours', totalCost: 42, currency: 'USD', metricCount: 2 }] },
      });
      expect(evidence.resources[0]?.usage).toEqual([]);
      expect(repository.summaryFilters?.startDate?.toISOString()).toBe('2026-06-23T12:00:00.000Z');
      expect(repository.summaryFilters?.endDate?.toISOString()).toBe('2026-06-30T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
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
    externalResourceId: 'ocid1.instance.oc1..exampleid0017',
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
    externalResourceId: 'ocid1.instance.oc1..exampleid0017',
    cloudResourceId: 'cloud-resource-1',
    resourceType: 'COMPUTE_INSTANCE',
    serviceName: 'Compute',
    metricName,
    providerNamespace: 'oci_computeagent',
    statistic: 'MEAN',
    metricUnit: 'Percent',
    sampleCount: 168,
    coverageDays: 7,
    granularitySeconds: 3600,
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
