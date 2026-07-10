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
  toCloudResourceItem,
  toResourceMetricSampleItem,
} from './mappers/technicalMetricsMappers.js';

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
    const resources = await this.prisma.cloudResource.findMany({
      where: { tenantId },
      orderBy: { lastSeenAt: 'desc' },
      take: limit,
    });

    return resources.map((resource) => toCloudResourceItem(resource));
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
          AND (sampled_at, external_resource_id, metric_name) >
            (${cursor.bucketStart}, ${cursor.externalResourceId}, ${cursor.metricName})
        `;

    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
      SELECT
        sampled_at AS bucket_start,
        external_resource_id,
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
      ORDER BY sampled_at ASC, external_resource_id ASC, metric_name ASC
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
          AND (${bucketExpression}, ${resourceExpression}, metric_name) >
            (${cursor.bucketStart}, ${cursor.externalResourceId}, ${cursor.metricName})
        `;

    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
        WITH filtered AS (
          SELECT
            ${bucketExpression} AS bucket_start,
            ${resourceExpression} AS external_resource_id,
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
          GROUP BY bucket_start, external_resource_id, metric_name, metric_unit
        )
        SELECT *
        FROM grouped
        ORDER BY bucket_start ASC, external_resource_id ASC, metric_name ASC
        LIMIT ${limit}
      `);
  }

  public async listMetricCoverageSamplesForTenant(
    tenantId: string,
    filters: TechnicalMetricCoverageFilters,
  ): Promise<readonly TechnicalMetricCoverageSampleItem[]> {
    return this.prisma.resourceMetricSample.findMany({
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
      },
      orderBy: { sampledAt: 'asc' },
      select: {
        externalResourceId: true,
        metricName: true,
        sampledAt: true,
      },
    });
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
          count(DISTINCT external_resource_id)::bigint AS resource_count,
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
  ): Promise<readonly TechnicalCostContextItem[]> {
    if (externalResourceIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.costMetric.groupBy({
      by: ['resourceId', 'billingCurrency'],
      where: {
        tenantId,
        resourceId: { in: [...externalResourceIds] },
      },
      _sum: { billedCost: true },
      _count: { metricIdentityHash: true },
    });

    return rows.map((row) => ({
      externalResourceId: row.resourceId,
      totalCost: Number(row._sum.billedCost ?? 0),
      currency: row.billingCurrency,
      metricCount: row._count.metricIdentityHash,
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
        SELECT DISTINCT ON (tenant_id, external_resource_id, metric_name)
          tenant_id,
          external_resource_id,
          metric_name,
          value::float8 AS latest_value,
          sampled_at AS latest_sampled_at
        FROM resource_metric_samples
        WHERE ${where}
        ORDER BY tenant_id, external_resource_id, metric_name, sampled_at DESC
      )
      SELECT
        rms.provider::text AS provider,
        rms.external_resource_id,
        max(rms.cloud_resource_id) AS cloud_resource_id,
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
        min(rms.sampled_at) AS first_sampled_at,
        max(rms.sampled_at) AS latest_sampled_at,
        max(latest.latest_value)::float8 AS latest_value
      FROM resource_metric_samples rms
      LEFT JOIN cloud_resources cr ON cr.id = rms.cloud_resource_id
      LEFT JOIN latest
        ON latest.tenant_id = rms.tenant_id
        AND latest.external_resource_id = rms.external_resource_id
        AND latest.metric_name = rms.metric_name
      WHERE ${aliasedWhere}
      GROUP BY rms.provider, rms.external_resource_id, rms.metric_name
      ORDER BY sample_count DESC, rms.external_resource_id ASC, rms.metric_name ASC
      LIMIT ${filters.limit}
    `);

    return rows.map((row) => ({
      provider: row.provider,
      externalResourceId: row.external_resource_id,
      ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
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

interface RawMetricSeriesRow {
  readonly bucket_start: Date;
  readonly external_resource_id: string;
  readonly metric_name: string;
  readonly metric_unit: string | null;
  readonly avg_value: number;
  readonly min_value: number;
  readonly max_value: number;
  readonly latest_value: number;
  readonly sample_count: number;
  readonly min_sampled_at: Date | null;
  readonly max_sampled_at: Date | null;
  readonly latest_sampled_at: Date | null;
}

interface RawMetricSummaryRow {
  readonly provider: string;
  readonly external_resource_id: string;
  readonly cloud_resource_id: string | null;
  readonly resource_type: string | null;
  readonly service_name: string | null;
  readonly metric_name: string;
  readonly metric_unit: string | null;
  readonly sample_count: number;
  readonly coverage_days: number;
  readonly min_value: number;
  readonly max_value: number;
  readonly avg_value: number;
  readonly p50_value: number;
  readonly p95_value: number;
  readonly p99_value: number;
  readonly latest_value: number;
  readonly first_sampled_at: Date;
  readonly latest_sampled_at: Date;
}

interface MetricSeriesCursor {
  readonly kind: 'compound' | 'legacy-date';
  readonly bucketStart: Date;
  readonly externalResourceId: string;
  readonly metricName: string;
}

function buildMetricSeriesCursor(row: RawMetricSeriesRow | undefined): string | undefined {
  if (row === undefined) {
    return undefined;
  }

  return [
    row.bucket_start.toISOString(),
    row.external_resource_id,
    row.metric_name,
  ].map((part) => encodeURIComponent(part)).join('|');
}

function parseMetricSeriesCursor(cursor: string | undefined): MetricSeriesCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  const parts = cursor.split('|');
  if (parts.length !== 3) {
    return parseLegacyDateCursor(cursor);
  }

  const [rawBucketStart, rawExternalResourceId, rawMetricName] = parts;
  if (
    rawBucketStart === undefined ||
    rawExternalResourceId === undefined ||
    rawMetricName === undefined
  ) {
    return undefined;
  }

  const bucketStart = new Date(decodeURIComponent(rawBucketStart));
  const externalResourceId = decodeURIComponent(rawExternalResourceId);
  const metricName = decodeURIComponent(rawMetricName);

  if (
    Number.isNaN(bucketStart.getTime()) ||
    externalResourceId.trim() === '' ||
    metricName.trim() === ''
  ) {
    return undefined;
  }

  return { kind: 'compound', bucketStart, externalResourceId, metricName };
}

function parseLegacyDateCursor(cursor: string): MetricSeriesCursor | undefined {
  const bucketStart = new Date(cursor);
  if (Number.isNaN(bucketStart.getTime())) {
    return undefined;
  }

  return {
    kind: 'legacy-date',
    bucketStart,
    externalResourceId: '',
    metricName: '',
  };
}

function buildMetricWhereClause(
  tenantId: string,
  filters: MetricWhereFilters,
  includeCursor: boolean,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`tenant_id = ${tenantId}`];

  if (filters.startDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at >= ${filters.startDate}`);
  }
  if (filters.endDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at <= ${filters.endDate}`);
  }
  if (filters.externalResourceId !== undefined) {
    clauses.push(Prisma.sql`external_resource_id = ${filters.externalResourceId}`);
  }
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }
  if (includeCursor && filters.cursor !== undefined) {
    clauses.push(Prisma.sql`sampled_at > ${filters.cursor}`);
  }

  return Prisma.join(clauses, ' AND ');
}

interface MetricWhereFilters {
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly externalResourceId?: string;
  readonly metricNames?: readonly string[];
  readonly cursor?: string;
}

function buildBucketExpression(bucket: TechnicalMetricSeriesFilters['bucket']): Prisma.Sql {
  if (bucket === 'raw') {
    return Prisma.sql`sampled_at`;
  }
  if (bucket === '30m') {
    return Prisma.sql`to_timestamp(floor(extract(epoch from sampled_at) / 1800) * 1800)`;
  }
  if (bucket === 'hour') {
    return Prisma.sql`date_trunc('hour', sampled_at)`;
  }

  return Prisma.sql`date_trunc('day', sampled_at)`;
}

function buildMetricSummaryWhereClause(
  tenantId: string,
  filters: TechnicalMetricSummaryFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`tenant_id = ${tenantId}`];

  if (filters.startDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at >= ${filters.startDate}`);
  }
  if (filters.endDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at <= ${filters.endDate}`);
  }
  if (filters.externalResourceIds !== undefined && filters.externalResourceIds.length > 0) {
    clauses.push(Prisma.sql`external_resource_id IN (${Prisma.join([...filters.externalResourceIds])})`);
  }
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }

  return Prisma.join(clauses, ' AND ');
}

function buildAliasedMetricSummaryWhereClause(
  tenantId: string,
  filters: TechnicalMetricSummaryFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`rms.tenant_id = ${tenantId}`];

  if (filters.startDate !== undefined) {
    clauses.push(Prisma.sql`rms.sampled_at >= ${filters.startDate}`);
  }
  if (filters.endDate !== undefined) {
    clauses.push(Prisma.sql`rms.sampled_at <= ${filters.endDate}`);
  }
  if (filters.externalResourceIds !== undefined && filters.externalResourceIds.length > 0) {
    clauses.push(Prisma.sql`rms.external_resource_id IN (${Prisma.join([...filters.externalResourceIds])})`);
  }
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`rms.metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }

  return Prisma.join(clauses, ' AND ');
}

function mapMetricSeriesRow(row: RawMetricSeriesRow): TechnicalMetricSeriesRepositoryPoint {
  return {
    bucketStart: row.bucket_start,
    externalResourceId: row.external_resource_id,
    metricName: row.metric_name,
    ...(row.metric_unit !== null ? { metricUnit: row.metric_unit } : {}),
    avg: roundMetric(row.avg_value),
    min: roundMetric(row.min_value),
    max: roundMetric(row.max_value),
    latest: roundMetric(row.latest_value),
    sampleCount: row.sample_count,
    ...(row.min_sampled_at !== null ? { minSampledAt: row.min_sampled_at } : {}),
    ...(row.max_sampled_at !== null ? { maxSampledAt: row.max_sampled_at } : {}),
    ...(row.latest_sampled_at !== null ? { latestSampledAt: row.latest_sampled_at } : {}),
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
