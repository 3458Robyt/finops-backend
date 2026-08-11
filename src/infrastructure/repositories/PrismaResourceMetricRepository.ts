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
  buildBucketExpression,
  buildMetricSeriesCursor,
  buildMetricSummaryWhereClause,
  buildMetricWhereClause,
  mapMetricSeriesRow,
  parseMetricSeriesCursor,
  type MetricSeriesCursor,
  type RawMetricSummaryRow,
  type RawMetricSeriesRow,
} from './technicalMetricQueryHelpers.js';

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
  constructor(private readonly prisma: PrismaClient) {}

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
    const pageSize = filters.pageSize;
    const limit = pageSize + 1;
    const where = buildMetricWhereClause(tenantId, filters, false);
    const cursor = parseMetricSeriesCursor(filters.cursor);
    const rowsPromise = filters.bucket === 'raw'
      ? this.listRawMetricSeriesRows(where, cursor, limit)
      : this.listAggregatedMetricSeriesRows(where, cursor, filters.bucket, limit);

    const [totalSamples, rows] = await Promise.all([
      cursor === undefined ? this.countMetricSamples(tenantId, filters) : Promise.resolve(0),
      rowsPromise,
    ]);

    const hasMore = rows.length > pageSize;
    const visibleRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore ? buildMetricSeriesCursor(visibleRows.at(-1)) : undefined;

    return {
      points: visibleRows.map((row) => mapMetricSeriesRow(row)),
      totalSamples,
      hasMore,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  private async listRawMetricSeriesRows(
    where: Prisma.Sql,
    cursor: MetricSeriesCursor | undefined,
    limit: number,
  ): Promise<RawMetricSeriesRow[]> {
    const cursorCondition = cursor === undefined
      ? Prisma.empty
      : cursor.kind === 'legacy-date'
        ? Prisma.sql`AND sampled_at > ${cursor.bucketStart}`
        : Prisma.sql`
          AND (sampled_at, external_resource_id, COALESCE(cloud_resource_id, ''), metric_name) >
            (${cursor.bucketStart}, ${cursor.externalResourceId}, ${cursor.cloudResourceId}, ${cursor.metricName})
        `;

    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
      SELECT
        sampled_at AS bucket_start,
        external_resource_id,
        cloud_resource_id,
        metric_name,
        metric_unit,
        value::float8 AS avg_value,
        value::float8 AS min_value,
        value::float8 AS max_value,
        value::float8 AS latest_value,
        1::int AS sample_count,
        sampled_at AS min_sampled_at,
        sampled_at AS max_sampled_at,
        sampled_at AS latest_sampled_at
      FROM resource_metric_samples
      WHERE ${where}
      ${cursorCondition}
      ORDER BY sampled_at ASC, external_resource_id ASC, COALESCE(cloud_resource_id, '') ASC, metric_name ASC
      LIMIT ${limit}
    `);
  }

  private async listAggregatedMetricSeriesRows(
    where: Prisma.Sql,
    cursor: MetricSeriesCursor | undefined,
    bucket: TechnicalMetricSeriesFilters['bucket'],
    limit: number,
  ): Promise<RawMetricSeriesRow[]> {
    const bucketExpression = buildBucketExpression(bucket);
    const resourceExpression = Prisma.sql`external_resource_id`;
    const cursorCondition = cursor === undefined
      ? Prisma.empty
      : cursor.kind === 'legacy-date'
        ? Prisma.sql`AND ${bucketExpression} > ${cursor.bucketStart}`
        : Prisma.sql`
          AND (${bucketExpression}, ${resourceExpression}, COALESCE(cloud_resource_id, ''), metric_name) >
            (${cursor.bucketStart}, ${cursor.externalResourceId}, ${cursor.cloudResourceId}, ${cursor.metricName})
        `;

    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
        WITH filtered AS (
          SELECT
            ${bucketExpression} AS bucket_start,
            ${resourceExpression} AS external_resource_id,
            cloud_resource_id,
            metric_name,
            metric_unit,
            sampled_at,
            value::float8 AS value
          FROM resource_metric_samples
          WHERE ${where}
          ${cursorCondition}
        ),
        grouped AS (
          SELECT
            bucket_start,
            external_resource_id,
            cloud_resource_id,
            metric_name,
            metric_unit,
            avg(value)::float8 AS avg_value,
            min(value)::float8 AS min_value,
            max(value)::float8 AS max_value,
            (array_agg(value ORDER BY sampled_at DESC))[1]::float8 AS latest_value,
            count(*)::int AS sample_count,
            (array_agg(sampled_at ORDER BY value ASC, sampled_at ASC))[1] AS min_sampled_at,
            (array_agg(sampled_at ORDER BY value DESC, sampled_at ASC))[1] AS max_sampled_at,
            max(sampled_at) AS latest_sampled_at
          FROM filtered
          GROUP BY bucket_start, external_resource_id, cloud_resource_id, metric_name, metric_unit
        )
        SELECT *
        FROM grouped
        ORDER BY bucket_start ASC, external_resource_id ASC, COALESCE(cloud_resource_id, '') ASC, metric_name ASC
        LIMIT ${limit}
      `);
  }

  public async listMetricCoverageSamplesForTenant(
    tenantId: string,
    filters: TechnicalMetricCoverageFilters,
  ): Promise<readonly TechnicalMetricCoverageSampleItem[]> {
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
      },
      orderBy: { sampledAt: 'asc' },
      select: {
        externalResourceId: true,
        cloudResourceId: true,
        metricName: true,
        sampledAt: true,
      },
    });
    return samples.map((sample) => ({
      externalResourceId: sample.externalResourceId,
      ...(sample.cloudResourceId !== null ? { cloudResourceId: sample.cloudResourceId } : {}),
      metricName: sample.metricName,
      sampledAt: sample.sampledAt,
    }));
  }

  public async getMetricCoverageForTenant(
    tenantId: string,
    filters: TechnicalMetricCoverageFilters,
  ): Promise<TechnicalMetricCoverageAggregate> {
    const where = buildMetricWhereClause(tenantId, filters, false);
    const [summaryRows, metricRows, dayRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        readonly total_samples: bigint;
        readonly metric_count: bigint;
        readonly resource_count: bigint;
        readonly min_sampled_at: Date | null;
        readonly max_sampled_at: Date | null;
      }>>(Prisma.sql`
        SELECT
          count(*)::bigint AS total_samples,
          count(DISTINCT metric_name)::bigint AS metric_count,
          count(DISTINCT COALESCE('cloud:' || cloud_resource_id, 'external:' || external_resource_id))::bigint AS resource_count,
          min(sampled_at) AS min_sampled_at,
          max(sampled_at) AS max_sampled_at
        FROM resource_metric_samples
        WHERE ${where}
      `),
      this.prisma.$queryRaw<Array<{
        readonly metric_name: string;
        readonly sample_count: bigint;
        readonly days_with_data: bigint;
        readonly min_sampled_at: Date | null;
        readonly max_sampled_at: Date | null;
      }>>(Prisma.sql`
        SELECT
          metric_name,
          count(*)::bigint AS sample_count,
          count(DISTINCT sampled_at::date)::bigint AS days_with_data,
          min(sampled_at) AS min_sampled_at,
          max(sampled_at) AS max_sampled_at
        FROM resource_metric_samples
        WHERE ${where}
        GROUP BY metric_name
      `),
      this.prisma.$queryRaw<Array<{
        readonly date: string;
        readonly sample_count: bigint;
        readonly metric_count: bigint;
      }>>(Prisma.sql`
        SELECT
          to_char(date_trunc('day', sampled_at), 'YYYY-MM-DD') AS date,
          count(*)::bigint AS sample_count,
          count(DISTINCT metric_name)::bigint AS metric_count
        FROM resource_metric_samples
        WHERE ${where}
        GROUP BY date_trunc('day', sampled_at)
        ORDER BY date ASC
      `),
    ]);

    const summary = summaryRows[0];
    return {
      totalSamples: Number(summary?.total_samples ?? 0n),
      metricCount: Number(summary?.metric_count ?? 0n),
      resourceCount: Number(summary?.resource_count ?? 0n),
      ...(summary?.min_sampled_at !== null && summary?.min_sampled_at !== undefined
        ? { minSampledAt: summary.min_sampled_at }
        : {}),
      ...(summary?.max_sampled_at !== null && summary?.max_sampled_at !== undefined
        ? { maxSampledAt: summary.max_sampled_at }
        : {}),
      metrics: metricRows.map((row) => ({
        metricName: row.metric_name,
        sampleCount: Number(row.sample_count),
        daysWithData: Number(row.days_with_data),
        ...(row.min_sampled_at !== null ? { minSampledAt: row.min_sampled_at } : {}),
        ...(row.max_sampled_at !== null ? { maxSampledAt: row.max_sampled_at } : {}),
      })),
      days: dayRows.map((row) => ({
        date: row.date,
        sampleCount: Number(row.sample_count),
        metricCount: Number(row.metric_count),
      })),
    };
  }

  public async listCostContextForResources(
    tenantId: string,
    externalResourceIds: readonly string[],
    cloudResourceIds?: readonly string[],
  ): Promise<readonly TechnicalCostContextItem[]> {
    const normalizedResourceIds = [...new Set(externalResourceIds.map((value) => value.trim()).filter((value) => value !== ''))];
    const normalizedCloudResourceIds = [...new Set((cloudResourceIds ?? []).map((value) => value.trim()).filter((value) => value !== ''))];
    if (normalizedResourceIds.length === 0 && normalizedCloudResourceIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<Array<{
      readonly external_resource_id: string;
      readonly cloud_resource_id: string | null;
      readonly cloud_connection_id: string | null;
      readonly total_cost: number;
      readonly currency: string;
      readonly metric_count: number;
    }>>(Prisma.sql`
      SELECT
        COALESCE(cr.external_resource_id, btrim(cm.resource_id)) AS external_resource_id,
        cm.cloud_resource_id,
        cm.cloud_connection_id,
        sum(cm.billed_cost)::float8 AS total_cost,
        cm.billing_currency AS currency,
        count(*)::int AS metric_count
      FROM cost_metrics cm
      LEFT JOIN cloud_resources cr
        ON cr.id = cm.cloud_resource_id
       AND cr.tenant_id = cm.tenant_id
      WHERE cm.tenant_id = ${tenantId}
        AND (
          (${normalizedCloudResourceIds.length > 0 ? Prisma.sql`cm.cloud_resource_id IN (${Prisma.join(normalizedCloudResourceIds)})` : Prisma.sql`FALSE`})
          OR (
          (
            cm.cloud_resource_id IS NOT NULL
            AND ${normalizedResourceIds.length > 0 ? Prisma.sql`cr.external_resource_id IN (${Prisma.join(normalizedResourceIds)})` : Prisma.sql`FALSE`}
          )
          OR (
            cm.cloud_resource_id IS NULL
            AND ${normalizedResourceIds.length > 0 ? Prisma.sql`btrim(cm.resource_id) IN (${Prisma.join(normalizedResourceIds)})` : Prisma.sql`FALSE`}
            AND NOT EXISTS (
              SELECT 1
              FROM cloud_resources exact_resource
              WHERE exact_resource.tenant_id = cm.tenant_id
                AND exact_resource.cloud_connection_id = cm.cloud_connection_id
                AND btrim(exact_resource.external_resource_id) = btrim(cm.resource_id)
            )
          )
          )
        )
      GROUP BY COALESCE(cr.external_resource_id, btrim(cm.resource_id)), cm.cloud_resource_id, cm.cloud_connection_id, cm.billing_currency
    `);

    return rows.map((row) => ({
      externalResourceId: row.external_resource_id,
      ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
      ...(row.cloud_connection_id !== null ? { cloudConnectionId: row.cloud_connection_id } : {}),
      totalCost: Number(row.total_cost),
      currency: row.currency,
      metricCount: row.metric_count,
    }));
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

  private async countMetricSamples(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
  ): Promise<number> {
    const countWhere = buildMetricWhereClause(tenantId, filters, false);
    const rows = await this.prisma.$queryRaw<{ readonly total: bigint }[]>(Prisma.sql`
      SELECT count(*)::bigint AS total
      FROM resource_metric_samples
      WHERE ${countWhere}
    `);

    return Number(rows[0]?.total ?? 0n);
  }
}
