import { describe, expect, test } from 'vitest';
import { TechnicalMetricsService } from './TechnicalMetricsService.js';
import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
  TechnicalMetricCoverageFilters,
  TechnicalMetricCoverageSampleItem,
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryResult,
  TechnicalMetricSummaryFilters,
  TechnicalMetricSummaryItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';

class FakeResourceMetricRepository implements IResourceMetricRepository {
  public resourcesQuery: { tenantId: string; limit: number } | null = null;
  public samplesQuery: { tenantId: string; limit: number } | null = null;
  public filteredSamplesQuery: { tenantId: string; limit: number } | null = null;
  public seriesQuery: { tenantId: string; filters: TechnicalMetricSeriesFilters } | null = null;
  public costContextQuery: { tenantId: string; externalResourceIds: readonly string[] } | null = null;
  public summaries: readonly TechnicalMetricSummaryItem[] = [];
  public resources: readonly CloudResourceItem[] = [
    {
      id: 'res-1',
      provider: 'AWS',
      externalResourceId: 'i-0abc',
      name: 'web-prod-01',
      resourceType: 'ec2:instance',
      serviceName: 'Amazon EC2',
      regionId: 'us-east-1',
      status: 'ACTIVE',
      firstSeenAt: new Date('2026-04-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-04-30T00:00:00.000Z'),
    },
  ];
  public samples: readonly ResourceMetricSampleItem[] = [
    {
      id: 'sample-1',
      provider: 'AWS',
      externalResourceId: 'i-0abc',
      metricName: 'cpu_utilization',
      metricUnit: 'Percent',
      value: 12.5,
      sampledAt: new Date('2026-04-30T00:00:00.000Z'),
      granularitySeconds: 1800,
    },
    {
      id: 'sample-2',
      provider: 'AWS',
      externalResourceId: 'i-0abc',
      metricName: 'cpu_utilization',
      metricUnit: 'Percent',
      value: 10,
      sampledAt: new Date('2026-04-30T00:30:00.000Z'),
      granularitySeconds: 1800,
    },
    {
      id: 'sample-3',
      provider: 'AWS',
      externalResourceId: 'i-0abc',
      metricName: 'memory_utilization',
      metricUnit: 'Percent',
      value: 90,
      sampledAt: new Date('2026-04-30T00:30:00.000Z'),
      granularitySeconds: 1800,
    },
  ];
  public costContext = [
    {
      externalResourceId: 'i-0abc',
      totalCost: 42.25,
      currency: 'USD',
      metricCount: 3,
    },
  ];

  public async listResourcesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly CloudResourceItem[]> {
    this.resourcesQuery = { tenantId, limit };
    return this.resources;
  }

  public async listMetricSamplesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    this.samplesQuery = { tenantId, limit };
    return this.samples;
  }

  public async listMetricSamplesForTenantByFilter(
    tenantId: string,
    filters: { readonly limit: number },
  ): Promise<readonly ResourceMetricSampleItem[]> {
    this.filteredSamplesQuery = { tenantId, limit: filters.limit };
    return this.samples;
  }

  public async listMetricSeriesForTenant(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
  ): Promise<TechnicalMetricSeriesRepositoryResult> {
    this.seriesQuery = { tenantId, filters };
    return {
      points: [
        {
          bucketStart: new Date('2026-04-30T00:00:00.000Z'),
          externalResourceId: 'i-0abc',
          metricName: 'cpu_utilization',
          metricUnit: 'Percent',
          avg: 11.25,
          min: 10,
          max: 12.5,
          latest: 10,
          sampleCount: 2,
          minSampledAt: new Date('2026-04-30T00:30:00.000Z'),
          maxSampledAt: new Date('2026-04-30T00:00:00.000Z'),
          latestSampledAt: new Date('2026-04-30T00:30:00.000Z'),
        },
        ],
        totalSamples: 2,
        hasMore: true,
        nextCursor: '2026-04-30T00%3A00%3A00.000Z|resource-1|cpu_utilization',
      };
    }

  public async listMetricCoverageSamplesForTenant(
    _tenantId: string,
    _filters: TechnicalMetricCoverageFilters,
  ): Promise<readonly TechnicalMetricCoverageSampleItem[]> {
    return this.samples.map((sample) => ({
      externalResourceId: sample.externalResourceId,
      metricName: sample.metricName,
      sampledAt: sample.sampledAt,
    }));
  }

  public async listCostContextForResources(
    tenantId: string,
    externalResourceIds: readonly string[],
  ) {
    this.costContextQuery = { tenantId, externalResourceIds };
    return this.costContext;
  }

  public async listMetricSummariesForTenant(
    _tenantId: string,
    _filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    return this.summaries;
  }
}

describe('TechnicalMetricsService', () => {
  test('returns a resource summary scoped to its tenant resource', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.summaries = [{
      provider: 'AWS', externalResourceId: 'i-0abc', metricName: 'cpu_utilization', sampleCount: 2,
      coverageDays: 1, min: 10, max: 12.5, avg: 11.25, p50: 11.25, p95: 12.5, p99: 12.5,
      latest: 10, firstSampledAt: new Date('2026-04-30T00:00:00.000Z'), latestSampledAt: new Date('2026-04-30T00:30:00.000Z'),
    }];
    const service = new TechnicalMetricsService(repository);

    const summary = await service.getResourceSummary('tenant-a', 'i-0abc');

    expect(summary?.resource.externalResourceId).toBe('i-0abc');
    expect(summary?.metrics).toHaveLength(1);
    expect(summary?.cost?.totalCost).toBe(42.25);
  });

  test('does not return an unlisted resource', async () => {
    const service = new TechnicalMetricsService(new FakeResourceMetricRepository());

    await expect(service.getResourceSummary('tenant-a', 'i-not-owned')).resolves.toBeUndefined();
  });
  test('lists cloud resources scoped to the tenant with the default limit', async () => {
    const repository = new FakeResourceMetricRepository();
    const service = new TechnicalMetricsService(repository);

    const resources = await service.listResources('tenant-1');

    expect(resources).toHaveLength(1);
    expect(resources[0]?.externalResourceId).toBe('i-0abc');
    expect(repository.resourcesQuery).toEqual({ tenantId: 'tenant-1', limit: 50 });
  });

  test('clamps an out-of-range sample limit to the allowed maximum', async () => {
    const repository = new FakeResourceMetricRepository();
    const service = new TechnicalMetricsService(repository);

    await service.listMetricSamples('tenant-1', 9999);

    expect(repository.samplesQuery).toEqual({ tenantId: 'tenant-1', limit: 200 });
  });

  test('returns metric samples scoped to the tenant', async () => {
    const repository = new FakeResourceMetricRepository();
    const service = new TechnicalMetricsService(repository);

    const samples = await service.listMetricSamples('tenant-1', 25);

    expect(samples[0]?.metricName).toBe('cpu_utilization');
    expect(repository.samplesQuery).toEqual({ tenantId: 'tenant-1', limit: 25 });
  });

  test('returns an empty list when there are no resources', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.resources = [];
    const service = new TechnicalMetricsService(repository);

    expect(await service.listResources('tenant-1')).toEqual([]);
  });

  test('builds an overview from metric samples even when inventory is missing', async () => {
    const repository = new FakeResourceMetricRepository();
    repository.resources = [];
    const service = new TechnicalMetricsService(repository);

    const overview = await service.getOverview('tenant-1');

    expect(overview.resourceCount).toBe(1);
    expect(overview.metricCount).toBe(2);
    expect(overview.resources[0]?.externalResourceId).toBe('i-0abc');
    expect(overview.resources[0]?.cost?.matchLevel).toBe('EXACT');
    expect(overview.kpis.map((kpi) => kpi.group)).toEqual(['CPU', 'MEMORY']);
    expect(overview.opportunities.some((opportunity) => opportunity.id === 'i-0abc:low-cpu')).toBe(true);
    expect(overview.opportunities.some((opportunity) => opportunity.id === 'i-0abc:missing-inventory')).toBe(true);
  });

  test('aggregates metric series by hour bucket', async () => {
    const repository = new FakeResourceMetricRepository();
    const service = new TechnicalMetricsService(repository);

    const result = await service.getSeries('tenant-1', {
      metricNames: ['cpu_utilization'],
      bucket: 'hour',
      pageSize: 9000,
    });

    const cpuPoint = result.series.find((point) => point.metricName === 'cpu_utilization');
    expect(cpuPoint?.bucketStart.toISOString()).toBe('2026-04-30T00:00:00.000Z');
    expect(cpuPoint?.avg).toBe(11.25);
    expect(cpuPoint?.max).toBe(12.5);
    expect(cpuPoint?.latest).toBe(10);
    expect(cpuPoint?.maxSampledAt?.toISOString()).toBe('2026-04-30T00:00:00.000Z');
    expect(result.meta).toMatchObject({
      hasMore: true,
      returnedPoints: 1,
      totalSamples: 2,
      bucket: 'hour',
      pageSize: 5000,
    });
    expect(repository.seriesQuery?.filters).toMatchObject({
      metricNames: ['cpu_utilization'],
      bucket: 'hour',
      pageSize: 5000,
    });
  });

    test('keeps raw bucket exact instead of auto-upgrading granularity', async () => {
      const repository = new FakeResourceMetricRepository();
      const service = new TechnicalMetricsService(repository);

    await service.getSeries('tenant-1', {
      metricNames: ['cpu_utilization'],
      bucket: 'raw',
      pageSize: 1000,
    });

      expect(repository.seriesQuery?.filters.bucket).toBe('raw');
    });

    test('passes opaque cursor to repository for paginated series', async () => {
      const repository = new FakeResourceMetricRepository();
      const service = new TechnicalMetricsService(repository);

      await service.getSeries('tenant-1', {
        metricNames: ['cpu_utilization'],
        bucket: 'hour',
        cursor: '2026-04-30T00%3A00%3A00.000Z|resource-1|cpu_utilization',
      });

      expect(repository.seriesQuery?.filters.cursor).toBe(
        '2026-04-30T00%3A00%3A00.000Z|resource-1|cpu_utilization',
      );
    });
  });
