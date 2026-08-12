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
}
