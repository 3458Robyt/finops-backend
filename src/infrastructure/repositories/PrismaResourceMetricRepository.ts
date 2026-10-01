import type {
  CloudResourceFilters,
  CloudResourceIdentity,
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
  TechnicalCostContextItem,
  TechnicalMetricCoverageAggregate,
  TechnicalMetricCoverageFilters,
  TechnicalMetricCoverageSampleItem,
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryResult,
  TechnicalMetricSampleFilters,
  TechnicalMetricSummaryFilters,
  TechnicalMetricSummaryItem,
  MetricSourceDiagnostic,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { MetricStatistic } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  toCloudResourceItem,
  toResourceMetricSampleItem,
} from './mappers/technicalMetricsMappers.js';
import {
  buildAliasedMetricSummaryWhereClause,
  buildMetricSummaryWhereClause,
  type RawMetricSummaryRow,
} from './technicalMetricQueryHelpers.js';
import { PrismaResourceMetricCoverageReader } from './PrismaResourceMetricCoverageReader.js';
import { PrismaResourceMetricCostContextReader } from './PrismaResourceMetricCostContextReader.js';
import { PrismaResourceMetricSeriesReader } from './PrismaResourceMetricSeriesReader.js';
import { PrismaCloudResourceInventoryReader } from './PrismaCloudResourceInventoryReader.js';
import { PrismaResourceMetricSummaryReader } from './PrismaResourceMetricSummaryReader.js';
import type { CurrencyConverter } from '../finance/CurrencyConverter.js';

/**
 * Fachada de persistencia para las lecturas de métricas técnicas. Las consultas
 * pesadas están separadas en lectores especializados para mantener el adaptador
 * pequeño y permitir optimizarlas de forma independiente.
 */
export class PrismaResourceMetricRepository implements IResourceMetricRepository {
  private readonly seriesReader: PrismaResourceMetricSeriesReader;
  private readonly coverageReader: PrismaResourceMetricCoverageReader;
  private readonly costContextReader: PrismaResourceMetricCostContextReader;
  private readonly inventoryReader: PrismaCloudResourceInventoryReader;

  public async listMetricSourceDiagnosticsForTenant(
    tenantId: string,
    resources: readonly { readonly externalResourceId: string; readonly cloudConnectionId?: string }[],
  ): Promise<readonly MetricSourceDiagnostic[]> {
    const scoped = [...new Map(resources
      .filter((item): item is { externalResourceId: string; cloudConnectionId: string } =>
        item.cloudConnectionId !== undefined && item.externalResourceId.trim() !== '')
      .map((item) => [`${item.cloudConnectionId}\u0000${item.externalResourceId}`, item])).values()];
    if (scoped.length === 0) return [];
    const [definitions, jobs] = await Promise.all([
      this.prisma.cloudMetricDefinition.findMany({
        where: {
          tenantId,
          OR: scoped.map((item) => ({ cloudConnectionId: item.cloudConnectionId, externalResourceId: item.externalResourceId })),
          metricName: { in: ['CpuUtilization', 'MemoryUtilization'] },
        },
        select: { cloudConnectionId: true, externalResourceId: true, metricName: true, enabled: true, lastSeenAt: true },
      }),
      this.prisma.$queryRaw<Array<{ cloud_connection_id: string; status: string }>>(Prisma.sql`
        SELECT DISTINCT ON (cloud_connection_id) cloud_connection_id, status::text AS status
        FROM ingestion_jobs
        WHERE tenant_id = ${tenantId}
          AND source_type = 'TECHNICAL_METRIC'
          AND cloud_connection_id IN (${Prisma.join([...new Set(scoped.map((item) => item.cloudConnectionId))])})
        ORDER BY cloud_connection_id, created_at DESC, id DESC
      `),
    ]);
    const latestJob = new Map<string, string>();
    for (const job of jobs) latestJob.set(job.cloud_connection_id, job.status);
    return scoped.flatMap((resource) => (['CpuUtilization', 'MemoryUtilization'] as const).map((metricName) => {
      const matches = definitions.filter((definition) => definition.cloudConnectionId === resource.cloudConnectionId
        && definition.externalResourceId === resource.externalResourceId && definition.metricName === metricName);
      const lastDiscoveredAt = matches.map((item) => item.lastSeenAt).sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        externalResourceId: resource.externalResourceId,
        cloudConnectionId: resource.cloudConnectionId,
        metricName,
        catalogStatus: matches.length === 0 ? 'NOT_DISCOVERED' as const
          : matches.some((item) => item.enabled) ? 'ENABLED' as const : 'DISABLED' as const,
        ...(lastDiscoveredAt === undefined ? {} : { lastDiscoveredAt }),
        ...(latestJob.get(resource.cloudConnectionId) === undefined ? {} : { latestJobStatus: latestJob.get(resource.cloudConnectionId)! }),
      };
    }));
  }
  private readonly summaryReader: PrismaResourceMetricSummaryReader;

  constructor(
    private readonly prisma: PrismaClient,
    currencyConverter?: CurrencyConverter,
  ) {
    this.seriesReader = new PrismaResourceMetricSeriesReader(prisma);
    this.coverageReader = new PrismaResourceMetricCoverageReader(prisma);
    this.costContextReader = new PrismaResourceMetricCostContextReader(prisma, currencyConverter);
    this.inventoryReader = new PrismaCloudResourceInventoryReader(prisma);
    this.summaryReader = new PrismaResourceMetricSummaryReader(prisma);
  }

  public async listResourcesForTenant(
    tenantId: string,
    limit: number,
    filters: CloudResourceFilters = {},
  ): Promise<readonly CloudResourceItem[]> {
    return this.inventoryReader.listForTenant(tenantId, limit, filters);
  }

  public async listResourcesForTenantByIdentities(
    tenantId: string,
    identities: readonly CloudResourceIdentity[],
  ): Promise<readonly CloudResourceItem[]> {
    return this.inventoryReader.listByIdentities(tenantId, identities);
  }

  public async getResourceForTenantById(
    tenantId: string,
    cloudResourceId: string,
  ): Promise<CloudResourceItem | undefined> {
    const resource = await this.prisma.cloudResource.findFirst({
      where: { tenantId, id: cloudResourceId },
    });
    return resource === null ? undefined : toCloudResourceItem(resource);
  }

  public async listMetricSamplesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    const samples = await this.prisma.resourceMetricSample.findMany({
      where: { tenantId, statistic: 'MEAN' },
      orderBy: { sampledAt: 'desc' },
      take: limit,
    });
    return samples.map((sample) => toResourceMetricSampleItem(sample));
  }

  public async listMetricSamplesForTenantByFilter(
    tenantId: string,
    filters: TechnicalMetricSampleFilters,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    const samples = await this.prisma.resourceMetricSample.findMany({
      where: {
        tenantId,
        ...(filters.startDate !== undefined || filters.endDate !== undefined
          ? {
              sampledAt: {
                ...(filters.startDate !== undefined ? { gte: filters.startDate } : {}),
                ...(filters.endDate !== undefined ? { lte: filters.endDate } : {}),
              },
            }
          : {}),
        ...(filters.externalResourceId !== undefined
          ? { externalResourceId: filters.externalResourceId }
          : {}),
        ...(filters.cloudResourceId !== undefined
          ? { cloudResourceId: filters.cloudResourceId }
          : {}),
        ...(filters.metricNames !== undefined && filters.metricNames.length > 0
          ? { metricName: { in: [...filters.metricNames] } }
          : {}),
        statistic: filters.statistic ?? 'MEAN',
      },
      orderBy: { sampledAt: 'asc' },
      take: filters.limit,
    });
    return samples.map((sample) => toResourceMetricSampleItem(sample));
  }

  public async listMetricStatisticsForTenant(
    tenantId: string,
    filters: {
      readonly startDate?: Date;
      readonly endDate?: Date;
      readonly externalResourceId?: string;
      readonly cloudResourceId?: string;
      readonly metricNames?: readonly string[];
    },
  ): Promise<readonly { readonly metricName: string; readonly statistic: MetricStatistic }[]> {
    const summaryRows = await this.prisma.$queryRaw<Array<{
      readonly metric_name: string;
      readonly statistic: string;
    }>>(Prisma.sql`
      SELECT DISTINCT metric_name, statistic::text AS statistic
      FROM resource_metric_stream_summaries
      WHERE tenant_id = ${tenantId}
        AND (${filters.startDate === undefined ? Prisma.sql`TRUE` : Prisma.sql`last_sampled_at >= ${filters.startDate}`})
        AND (${filters.endDate === undefined ? Prisma.sql`TRUE` : Prisma.sql`first_sampled_at <= ${filters.endDate}`})
        AND (${filters.externalResourceId === undefined ? Prisma.sql`TRUE` : Prisma.sql`external_resource_id = ${filters.externalResourceId}`})
        AND (${filters.cloudResourceId === undefined ? Prisma.sql`TRUE` : Prisma.sql`cloud_resource_id = ${filters.cloudResourceId}`})
        AND (${filters.metricNames === undefined || filters.metricNames.length === 0
          ? Prisma.sql`TRUE`
          : Prisma.sql`metric_name IN (${Prisma.join([...filters.metricNames])})`})
      ORDER BY metric_name ASC, statistic ASC
    `);
    // The stream summary is the bounded catalog projection. Scanning millions
    // of raw samples on every default overview made the UI block for seconds.
    // Raw is retained as a compatibility fallback for a fresh/legacy tenant
    // whose summary projection has not been built yet.
    if (summaryRows.length > 0) {
      return summaryRows.map((row) => ({
        metricName: row.metric_name,
        statistic: row.statistic as MetricStatistic,
      }));
    }

    const rawRows = await this.prisma.$queryRaw<Array<{
      readonly metric_name: string;
      readonly statistic: string;
    }>>(Prisma.sql`
      SELECT DISTINCT metric_name, statistic::text AS statistic
      FROM resource_metric_samples
      WHERE tenant_id = ${tenantId}
        AND (${filters.startDate === undefined ? Prisma.sql`TRUE` : Prisma.sql`sampled_at >= ${filters.startDate}`})
        AND (${filters.endDate === undefined ? Prisma.sql`TRUE` : Prisma.sql`sampled_at <= ${filters.endDate}`})
        AND (${filters.externalResourceId === undefined ? Prisma.sql`TRUE` : Prisma.sql`external_resource_id = ${filters.externalResourceId}`})
        AND (${filters.cloudResourceId === undefined ? Prisma.sql`TRUE` : Prisma.sql`cloud_resource_id = ${filters.cloudResourceId}`})
        AND (${filters.metricNames === undefined || filters.metricNames.length === 0
          ? Prisma.sql`TRUE`
          : Prisma.sql`metric_name IN (${Prisma.join([...filters.metricNames])})`})
      ORDER BY metric_name ASC, statistic ASC
    `);
    return rawRows.map((row) => ({
      metricName: row.metric_name,
      statistic: row.statistic as MetricStatistic,
    }));
  }

  public async listMetricSeriesForTenant(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
  ): Promise<TechnicalMetricSeriesRepositoryResult> {
    return this.seriesReader.listForTenant(tenantId, filters);
  }

  public async listMetricCoverageSamplesForTenant(
    tenantId: string,
    filters: TechnicalMetricCoverageFilters,
  ): Promise<readonly TechnicalMetricCoverageSampleItem[]> {
    return this.coverageReader.listSamplesForTenant(tenantId, filters);
  }

  public async getMetricCoverageForTenant(
    tenantId: string,
    filters: TechnicalMetricCoverageFilters,
  ): Promise<TechnicalMetricCoverageAggregate> {
    return this.coverageReader.getForTenant(tenantId, filters);
  }

  public async listCostContextForResources(
    tenantId: string,
    externalResourceIds: readonly string[],
    cloudResourceIds?: readonly string[],
    period?: Readonly<{ readonly start: Date; readonly end: Date }>,
  ): Promise<readonly TechnicalCostContextItem[]> {
    return this.costContextReader.listForResources(tenantId, externalResourceIds, cloudResourceIds, period);
  }

  public async listMetricSummariesForTenant(
    tenantId: string,
    filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    const where = buildMetricSummaryWhereClause(tenantId, filters);
    const aliasedWhere = buildAliasedMetricSummaryWhereClause(tenantId, filters);
    const rows = await this.prisma.$queryRaw<RawMetricSummaryRow[]>(Prisma.sql`
      SELECT
        rms.provider::text AS provider,
        rms.external_resource_id,
        rms.cloud_resource_id,
        rms.cloud_connection_id,
        rms.provider_namespace,
        rms.region_id,
        rms.compartment_id,
        rms.dimensions_hash,
        max(cr.name) AS resource_name,
        max(cr.resource_type) AS resource_type,
        max(cr.service_name) AS service_name,
        rms.metric_name,
        rms.statistic::text AS statistic,
        rms.metric_unit,
        rms.granularity_seconds::int AS granularity_seconds,
        count(DISTINCT rms.sampled_at)::int AS sample_count,
        count(DISTINCT rms.sampled_at::date)::int AS coverage_days,
        min(rms.value)::float8 AS min_value,
        max(rms.value)::float8 AS max_value,
        avg(rms.value)::float8 AS avg_value,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY rms.value)::float8 AS p50_value,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY rms.value)::float8 AS p95_value,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY rms.value)::float8 AS p99_value,
        count(*) FILTER (WHERE (
          (
            lower(coalesce(rms.metric_unit, '')) LIKE '%percent%'
            OR lower(coalesce(rms.metric_unit, '')) LIKE '%percentage%'
            OR lower(coalesce(rms.metric_unit, '')) = '%'
            OR lower(rms.metric_name) ~ '(cpu|memory|mem|utilization|util|percent|pct)'
          )
          AND rms.value >= 80
        ))::int AS high_utilization_sample_count,
        (count(*) FILTER (WHERE (
          (
            lower(coalesce(rms.metric_unit, '')) LIKE '%percent%'
            OR lower(coalesce(rms.metric_unit, '')) LIKE '%percentage%'
            OR lower(coalesce(rms.metric_unit, '')) = '%'
            OR lower(rms.metric_name) ~ '(cpu|memory|mem|utilization|util|percent|pct)'
          )
          AND rms.value >= 80
        ))::float8 / nullif(count(*)::float8, 0)) AS high_utilization_ratio,
        min(rms.sampled_at) AS first_sampled_at,
        max(rms.sampled_at) AS latest_sampled_at,
        (array_agg(rms.value::float8 ORDER BY rms.sampled_at DESC, rms.created_at DESC, rms.id DESC))[1]::float8 AS latest_value
      FROM resource_metric_samples rms
      LEFT JOIN cloud_resources cr ON cr.id = rms.cloud_resource_id
      WHERE ${aliasedWhere}
      GROUP BY rms.provider, rms.external_resource_id, rms.cloud_resource_id, rms.cloud_connection_id,
        rms.provider_namespace, rms.region_id, rms.compartment_id, rms.dimensions_hash,
        rms.metric_name, rms.metric_unit, rms.statistic, rms.granularity_seconds
      ORDER BY CASE WHEN lower(replace(rms.metric_name, '_', '')) IN ('cpuutilization', 'memoryutilization') THEN 0 ELSE 1 END,
        sample_count DESC, rms.external_resource_id ASC, rms.cloud_resource_id ASC NULLS LAST,
        rms.provider_namespace ASC, rms.region_id ASC, rms.metric_name ASC, rms.dimensions_hash ASC
      LIMIT ${filters.limit}
    `);

    return rows.map((row) => ({
      provider: row.provider,
      externalResourceId: row.external_resource_id,
      ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
      ...(row.cloud_connection_id !== null ? { cloudConnectionId: row.cloud_connection_id } : {}),
      ...(row.resource_name !== null ? { resourceName: row.resource_name } : {}),
      ...((row.provider_namespace ?? '') !== '' ? { providerNamespace: row.provider_namespace } : {}),
      ...((row.region_id ?? '') !== '' ? { regionId: row.region_id } : {}),
      ...((row.compartment_id ?? '') !== '' ? { compartmentId: row.compartment_id } : {}),
      ...((row.dimensions_hash ?? '') !== '' ? { dimensionsHash: row.dimensions_hash } : {}),
      ...(row.resource_type !== null ? { resourceType: row.resource_type } : {}),
      ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
      metricName: row.metric_name,
      statistic: row.statistic as MetricStatistic,
      granularitySeconds: row.granularity_seconds,
      ...(row.metric_unit !== null ? { metricUnit: row.metric_unit } : {}),
      sampleCount: row.sample_count,
      coverageDays: row.coverage_days,
      min: row.min_value,
      max: row.max_value,
      avg: row.avg_value,
      p50: row.p50_value,
      p95: row.p95_value,
      p99: row.p99_value,
      latest: row.latest_value,
      ...(row.high_utilization_sample_count !== null
        ? { highUtilizationSampleCount: row.high_utilization_sample_count }
        : {}),
      ...(row.high_utilization_ratio !== null ? { highUtilizationRatio: row.high_utilization_ratio } : {}),
      firstSampledAt: row.first_sampled_at,
      latestSampledAt: row.latest_sampled_at,
    }));
  }

  public listMetricSummariesForTenantFast(
    tenantId: string,
    filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    return this.summaryReader.listFast(tenantId, filters);
  }
}
