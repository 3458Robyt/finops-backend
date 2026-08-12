import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
  TechnicalCostContextItem,
  TechnicalMetricCoverageAggregate,
  TechnicalMetricCoverageFilters,
  TechnicalMetricCoverageSampleItem,
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryPoint,
  TechnicalMetricSeriesRepositoryResult,
  TechnicalMetricSampleFilters,
  TechnicalMetricSummaryFilters,
  TechnicalMetricSummaryItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  buildResourceFreshness,
  classifyResourceEvidenceStatus,
} from '../../domain/models/ResourceLinkage.js';
import {
  toCloudResourceItem,
  toResourceMetricSampleItem,
} from './mappers/technicalMetricsMappers.js';
import {
  buildAliasedMetricSummaryWhereClause,
  buildMetricSummaryWhereClause,
  buildMetricWhereClause,
  type RawMetricSummaryRow,
} from './technicalMetricQueryHelpers.js';
import { PrismaResourceMetricCoverageReader } from './PrismaResourceMetricCoverageReader.js';
import { PrismaResourceMetricCostContextReader } from './PrismaResourceMetricCostContextReader.js';
import { PrismaResourceMetricSeriesReader } from './PrismaResourceMetricSeriesReader.js';

interface CloudResourceLineageRow {
  readonly id: string;
  readonly cloud_connection_id: string;
  readonly provider: string;
  readonly external_resource_id: string;
  readonly name: string | null;
  readonly resource_type: string;
  readonly service_name: string;
  readonly region_id: string | null;
  readonly status: string;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
  readonly cost_count: bigint;
  readonly metric_count: bigint;
  readonly recommendation_count: bigint;
  readonly latest_cost_at: Date | null;
  readonly latest_metric_at: Date | null;
}

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link IResourceMetricRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: leer el inventario de recursos cloud (`cloud_resources`) y
 * sus muestras de métricas técnicas (`resource_metric_samples`), de forma
 * estrictamente separada del consumo facturado de FOCUS. Todas las consultas
 * filtran por `tenantId` para garantizar el aislamiento multi-tenant.
 */
export class PrismaResourceMetricRepository implements IResourceMetricRepository {
  private readonly seriesReader: PrismaResourceMetricSeriesReader;
  private readonly coverageReader: PrismaResourceMetricCoverageReader;
  private readonly costContextReader: PrismaResourceMetricCostContextReader;

  constructor(private readonly prisma: PrismaClient) {
    this.seriesReader = new PrismaResourceMetricSeriesReader(prisma);
    this.coverageReader = new PrismaResourceMetricCoverageReader(prisma);
    this.costContextReader = new PrismaResourceMetricCostContextReader(prisma);
  }

  /**
   * Lista los recursos cloud inventariados de un tenant, del visto más
   * recientemente al más antiguo, acotado a `limit`.
   *
   * @param tenantId Tenant cuyos recursos se consultan (aislamiento multi-tenant).
   * @param limit Número máximo de recursos a devolver.
   * @returns Recursos cloud de dominio; arreglo vacío si no hay.
   */
  public async listResourcesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly CloudResourceItem[]> {
    const rows = await this.prisma.$queryRaw<CloudResourceLineageRow[]>(Prisma.sql`
      WITH base_resources AS (
        SELECT id,
               cloud_connection_id,
               provider::text AS provider,
               external_resource_id,
               name,
               resource_type,
               service_name,
               region_id,
               status::text AS status,
               first_seen_at,
               last_seen_at
          FROM cloud_resources
         WHERE tenant_id = ${tenantId}
         ORDER BY last_seen_at DESC, id ASC
         LIMIT ${limit}
      ), costs AS (
        SELECT cm.cloud_resource_id,
               count(*)::bigint AS cost_count,
               max(cm.charge_period_end) AS latest_cost_at
          FROM cost_metrics cm
          INNER JOIN base_resources br ON br.id = cm.cloud_resource_id
         WHERE cm.tenant_id = ${tenantId}
         GROUP BY cm.cloud_resource_id
      ), metrics AS (
        SELECT rms.cloud_resource_id,
               count(*)::bigint AS metric_count,
               max(rms.sampled_at) AS latest_metric_at
          FROM resource_metric_samples rms
          INNER JOIN base_resources br ON br.id = rms.cloud_resource_id
         WHERE rms.tenant_id = ${tenantId}
         GROUP BY rms.cloud_resource_id
      ), recommendation_counts AS (
        SELECT rec.cloud_resource_id, count(*)::bigint AS recommendation_count
          FROM recommendations rec
          INNER JOIN base_resources br ON br.id = rec.cloud_resource_id
         WHERE rec.tenant_id = ${tenantId}
         GROUP BY rec.cloud_resource_id
      )
      SELECT br.id,
             br.cloud_connection_id,
             br.provider,
             br.external_resource_id,
             br.name,
             br.resource_type,
             br.service_name,
             br.region_id,
             br.status,
             br.first_seen_at,
             br.last_seen_at,
             coalesce(costs.cost_count, 0)::bigint AS cost_count,
             coalesce(metrics.metric_count, 0)::bigint AS metric_count,
             coalesce(recommendation_counts.recommendation_count, 0)::bigint AS recommendation_count,
             costs.latest_cost_at,
             metrics.latest_metric_at
        FROM base_resources br
        LEFT JOIN costs ON costs.cloud_resource_id = br.id
        LEFT JOIN metrics ON metrics.cloud_resource_id = br.id
        LEFT JOIN recommendation_counts ON recommendation_counts.cloud_resource_id = br.id
       ORDER BY br.last_seen_at DESC, br.id ASC
    `);

    return rows.map((row) => {
      const linkedCostCount = Number(row.cost_count);
      const linkedMetricSampleCount = Number(row.metric_count);
      const freshness = buildResourceFreshness({
        inventoryAt: row.last_seen_at,
        costsAt: row.latest_cost_at,
        metricsAt: row.latest_metric_at,
      });
      return {
        id: row.id,
        cloudConnectionId: row.cloud_connection_id,
        provider: row.provider,
        externalResourceId: row.external_resource_id,
        ...(row.name !== null ? { name: row.name } : {}),
        resourceType: row.resource_type,
        serviceName: row.service_name,
        ...(row.region_id !== null ? { regionId: row.region_id } : {}),
        status: row.status as CloudResourceItem['status'],
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        lineage: {
          status: classifyResourceEvidenceStatus({ costCount: linkedCostCount, metricCount: linkedMetricSampleCount, freshness }),
          linkedCostCount,
          linkedMetricSampleCount,
          linkedRecommendationCount: Number(row.recommendation_count),
          ...(row.latest_cost_at !== null ? { latestCostAt: row.latest_cost_at } : {}),
          ...(row.latest_metric_at !== null ? { latestMetricAt: row.latest_metric_at } : {}),
          freshness,
        },
      } satisfies CloudResourceItem;
    });
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

  /**
   * Lista las muestras de métricas técnicas de un tenant, de la más reciente a
   * la más antigua, acotado a `limit`.
   *
   * @param tenantId Tenant cuyas muestras se consultan (aislamiento multi-tenant).
   * @param limit Número máximo de muestras a devolver.
   * @returns Muestras de métricas técnicas de dominio; arreglo vacío si no hay.
   */
  public async listMetricSamplesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    const samples = await this.prisma.resourceMetricSample.findMany({
      where: { tenantId },
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
      },
      orderBy: { sampledAt: 'asc' },
      take: filters.limit,
    });

    return samples.map((sample) => toResourceMetricSampleItem(sample));
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
        SELECT DISTINCT ON (tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id, metric_name)
          tenant_id,
          cloud_connection_id,
          cloud_resource_id,
          external_resource_id,
          metric_name,
          value::float8 AS latest_value,
          sampled_at AS latest_sampled_at
        FROM resource_metric_samples
        WHERE ${where}
        ORDER BY tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id, metric_name, sampled_at DESC
      )
      SELECT
        rms.provider::text AS provider,
        rms.external_resource_id,
        rms.cloud_resource_id,
        rms.cloud_connection_id,
        max(cr.resource_type) AS resource_type,
        max(cr.service_name) AS service_name,
        rms.metric_name,
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
        AND latest.metric_name = rms.metric_name
      WHERE ${aliasedWhere}
      GROUP BY rms.provider, rms.external_resource_id, rms.cloud_resource_id, rms.cloud_connection_id, rms.metric_name
      ORDER BY sample_count DESC, rms.external_resource_id ASC, rms.cloud_resource_id ASC NULLS LAST, rms.metric_name ASC
      LIMIT ${filters.limit}
    `);

    return rows.map((row) => ({
      provider: row.provider,
      externalResourceId: row.external_resource_id,
      ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
      ...(row.cloud_connection_id !== null ? { cloudConnectionId: row.cloud_connection_id } : {}),
      ...(row.resource_type !== null ? { resourceType: row.resource_type } : {}),
      ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
      metricName: row.metric_name,
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
      ...(row.high_utilization_sample_count !== null ? { highUtilizationSampleCount: row.high_utilization_sample_count } : {}),
      ...(row.high_utilization_ratio !== null ? { highUtilizationRatio: row.high_utilization_ratio } : {}),
      firstSampledAt: row.first_sampled_at,
      latestSampledAt: row.latest_sampled_at,
    }));
  }

}
