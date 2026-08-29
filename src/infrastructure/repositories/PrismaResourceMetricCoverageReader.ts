import type {
  TechnicalMetricCoverageAggregate,
  TechnicalMetricCoverageFilters,
  TechnicalMetricCoverageSampleItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { buildMetricWhereClause } from './technicalMetricQueryHelpers.js';

/** Reads metric coverage and availability without coupling it to series SQL. */
export class PrismaResourceMetricCoverageReader {
  constructor(private readonly prisma: PrismaClient) {}

  public async listSamplesForTenant(
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
        statistic: filters.statistic ?? 'MEAN',
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

  public async getForTenant(
    tenantId: string,
    filters: TechnicalMetricCoverageFilters,
  ): Promise<TechnicalMetricCoverageAggregate> {
    const where = buildMetricWhereClause(tenantId, filters, false);
    // Keep the filtered relation inside one database statement. The previous
    // implementation started three independent scans of the raw table in
    // parallel; with a large tenant that saturated the database precisely
    // when the UI changed a metric or date range.
    const rows = await this.prisma.$queryRaw<RawCoverageRow[]>(Prisma.sql`
      WITH filtered AS MATERIALIZED (
        SELECT
          cloud_connection_id,
          cloud_resource_id,
          external_resource_id,
          metric_name,
          sampled_at
        FROM resource_metric_samples
        WHERE ${where}
      ), summary AS (
        SELECT
          count(*)::bigint AS total_samples,
          count(DISTINCT metric_name)::bigint AS metric_count,
          count(DISTINCT COALESCE(
            'cloud:' || cloud_resource_id,
            'external:' || cloud_connection_id || ':' || external_resource_id
          ))::bigint AS resource_count,
          min(sampled_at) AS min_sampled_at,
          max(sampled_at) AS max_sampled_at
        FROM filtered
      ), metric_rows AS (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'metricName', metric_name,
          'sampleCount', sample_count,
          'daysWithData', days_with_data,
          'minSampledAt', min_sampled_at,
          'maxSampledAt', max_sampled_at
        ) ORDER BY metric_name), '[]'::jsonb) AS metrics
        FROM (
          SELECT
            metric_name,
            count(*)::bigint AS sample_count,
            count(DISTINCT sampled_at::date)::bigint AS days_with_data,
            min(sampled_at) AS min_sampled_at,
            max(sampled_at) AS max_sampled_at
          FROM filtered
          GROUP BY metric_name
        ) grouped_metrics
      ), day_rows AS (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'date', date,
          'sampleCount', sample_count,
          'metricCount', metric_count
        ) ORDER BY date), '[]'::jsonb) AS days
        FROM (
          SELECT
            to_char(date_trunc('day', sampled_at), 'YYYY-MM-DD') AS date,
            count(*)::bigint AS sample_count,
            count(DISTINCT metric_name)::bigint AS metric_count
          FROM filtered
          GROUP BY date_trunc('day', sampled_at)
        ) grouped_days
      )
      SELECT
        summary.total_samples,
        summary.metric_count,
        summary.resource_count,
        summary.min_sampled_at,
        summary.max_sampled_at,
        metric_rows.metrics,
        day_rows.days
      FROM summary
      CROSS JOIN metric_rows
      CROSS JOIN day_rows
    `);

    const row = rows[0];
    return {
      totalSamples: Number(row?.total_samples ?? 0n),
      metricCount: Number(row?.metric_count ?? 0n),
      resourceCount: Number(row?.resource_count ?? 0n),
      ...(row?.min_sampled_at !== null && row?.min_sampled_at !== undefined
        ? { minSampledAt: row.min_sampled_at }
        : {}),
      ...(row?.max_sampled_at !== null && row?.max_sampled_at !== undefined
        ? { maxSampledAt: row.max_sampled_at }
        : {}),
      metrics: parseCoverageMetrics(row?.metrics),
      days: parseCoverageDays(row?.days),
    };
  }
}

interface RawCoverageRow {
  readonly total_samples: bigint;
  readonly metric_count: bigint;
  readonly resource_count: bigint;
  readonly min_sampled_at: Date | null;
  readonly max_sampled_at: Date | null;
  readonly metrics: unknown;
  readonly days: unknown;
}

interface RawCoverageMetric {
  readonly metricName?: unknown;
  readonly sampleCount?: unknown;
  readonly daysWithData?: unknown;
  readonly minSampledAt?: unknown;
  readonly maxSampledAt?: unknown;
}

interface RawCoverageDay {
  readonly date?: unknown;
  readonly sampleCount?: unknown;
  readonly metricCount?: unknown;
}

function parseCoverageMetrics(value: unknown): TechnicalMetricCoverageAggregate['metrics'] {
  return parseJsonArray<RawCoverageMetric>(value)
    .filter((item) => typeof item.metricName === 'string' && item.metricName.trim() !== '')
    .map((item) => {
      const minSampledAt = toDate(item.minSampledAt);
      const maxSampledAt = toDate(item.maxSampledAt);
      const metric: {
        metricName: string;
        sampleCount: number;
        daysWithData: number;
        minSampledAt?: Date;
        maxSampledAt?: Date;
      } = {
        metricName: item.metricName as string,
        sampleCount: toNumber(item.sampleCount),
        daysWithData: toNumber(item.daysWithData),
      };
      if (minSampledAt !== undefined) metric.minSampledAt = minSampledAt;
      if (maxSampledAt !== undefined) metric.maxSampledAt = maxSampledAt;
      return metric;
    });
}

function parseCoverageDays(value: unknown): TechnicalMetricCoverageAggregate['days'] {
  return parseJsonArray<RawCoverageDay>(value)
    .filter((item) => typeof item.date === 'string' && item.date.trim() !== '')
    .map((item) => ({
      date: item.date as string,
      sampleCount: toNumber(item.sampleCount),
      metricCount: toNumber(item.metricCount),
    }));
}

function parseJsonArray<T>(value: unknown): readonly T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
