import type {
  CloudResourceFilters,
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

  constructor(private readonly prisma: PrismaClient) {
    this.seriesReader = new PrismaResourceMetricSeriesReader(prisma);
    this.coverageReader = new PrismaResourceMetricCoverageReader(prisma);
    this.costContextReader = new PrismaResourceMetricCostContextReader(prisma);
    this.inventoryReader = new PrismaCloudResourceInventoryReader(prisma);
  }

  public async listResourcesForTenant(
    tenantId: string,
    limit: number,
    filters: CloudResourceFilters = {},
  ): Promise<readonly CloudResourceItem[]> {
    return this.inventoryReader.listForTenant(tenantId, limit, filters);
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
    const rows = await this.prisma.resourceMetricSample.findMany({
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
        ...(filters.externalResourceId !== undefined ? { externalResourceId: filters.externalResourceId } : {}),
        ...(filters.cloudResourceId !== undefined ? { cloudResourceId: filters.cloudResourceId } : {}),
        ...(filters.metricNames !== undefined && filters.metricNames.length > 0
          ? { metricName: { in: [...filters.metricNames] } }
          : {}),
      },
      select: { metricName: true, statistic: true },
      distinct: ['metricName', 'statistic'],
      orderBy: [{ metricName: 'asc' }, { statistic: 'asc' }],
    });
    return rows.map((row) => ({
      metricName: row.metricName,
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
  ): Promise<readonly TechnicalCostContextItem[]> {
    return this.costContextReader.listForResources(tenantId, externalResourceIds, cloudResourceIds);
  }

  public async listMetricSummariesForTenant(
    tenantId: string,
    filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    const where = buildMetricSummaryWhereClause(tenantId, filters);
    const aliasedWhere = buildAliasedMetricSummaryWhereClause(tenantId, filters);
    const rows = await this.prisma.$queryRaw<RawMetricSummaryRow[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (
          tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic
        )
          tenant_id,
          cloud_connection_id,
          cloud_resource_id,
          external_resource_id,
          provider_namespace,
          region_id,
          dimensions_hash,
          metric_name,
          statistic,
          value::float8 AS latest_value,
          sampled_at AS latest_sampled_at
        FROM resource_metric_samples
        WHERE ${where}
        ORDER BY tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic, sampled_at DESC
      )
      SELECT
        rms.provider::text AS provider,
        rms.external_resource_id,
        rms.cloud_resource_id,
        rms.cloud_connection_id,
        rms.provider_namespace,
        rms.region_id,
        rms.dimensions_hash,
        max(cr.resource_type) AS resource_type,
        max(cr.service_name) AS service_name,
        rms.metric_name,
        rms.statistic::text AS statistic,
        max(rms.metric_unit) AS metric_unit,
        count(*)::int AS sample_count,
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
        max(latest.latest_value)::float8 AS latest_value
      FROM resource_metric_samples rms
      LEFT JOIN cloud_resources cr ON cr.id = rms.cloud_resource_id
      LEFT JOIN latest
        ON latest.tenant_id = rms.tenant_id
        AND latest.cloud_connection_id IS NOT DISTINCT FROM rms.cloud_connection_id
        AND latest.cloud_resource_id IS NOT DISTINCT FROM rms.cloud_resource_id
        AND latest.external_resource_id = rms.external_resource_id
        AND latest.provider_namespace = rms.provider_namespace
        AND latest.region_id = rms.region_id
        AND latest.dimensions_hash = rms.dimensions_hash
        AND latest.metric_name = rms.metric_name
        AND latest.statistic = rms.statistic
      WHERE ${aliasedWhere}
      GROUP BY rms.provider, rms.external_resource_id, rms.cloud_resource_id, rms.cloud_connection_id,
        rms.provider_namespace, rms.region_id, rms.dimensions_hash, rms.metric_name, rms.statistic
      ORDER BY sample_count DESC, rms.external_resource_id ASC, rms.cloud_resource_id ASC NULLS LAST,
        rms.provider_namespace ASC, rms.region_id ASC, rms.metric_name ASC, rms.dimensions_hash ASC
      LIMIT ${filters.limit}
    `);

    return rows.map((row) => ({
      provider: row.provider,
      externalResourceId: row.external_resource_id,
      ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
      ...(row.cloud_connection_id !== null ? { cloudConnectionId: row.cloud_connection_id } : {}),
      ...((row.provider_namespace ?? '') !== '' ? { providerNamespace: row.provider_namespace } : {}),
      ...((row.region_id ?? '') !== '' ? { regionId: row.region_id } : {}),
      ...((row.dimensions_hash ?? '') !== '' ? { dimensionsHash: row.dimensions_hash } : {}),
      ...(row.resource_type !== null ? { resourceType: row.resource_type } : {}),
      ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
      metricName: row.metric_name,
      statistic: row.statistic as MetricStatistic,
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
}
