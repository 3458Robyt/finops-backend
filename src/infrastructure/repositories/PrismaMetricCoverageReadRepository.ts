import type {
  IngestionMetricCoverageQuery,
  IngestionMetricCoverageResult,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { isJsonObject } from './mappers/cloudConnectionMappers.js';

/** Reads metric coverage without coupling it to the ingestion job history facade. */
export class PrismaMetricCoverageReadRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async listMetricCoverageForTenant(
    input: IngestionMetricCoverageQuery,
  ): Promise<IngestionMetricCoverageResult> {
    const where = {
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      ...(input.startDate !== undefined ? { windowEnd: { gt: input.startDate } } : {}),
      ...(input.endDate !== undefined ? { windowStart: { lt: input.endDate } } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };
    const sqlWhere = Prisma.sql`
      tenant_id = ${input.tenantId}
      AND cloud_connection_id = ${input.cloudConnectionId}
      ${input.startDate === undefined ? Prisma.sql`` : Prisma.sql`AND window_end > ${input.startDate}`}
      ${input.endDate === undefined ? Prisma.sql`` : Prisma.sql`AND window_start < ${input.endDate}`}
      ${input.status === undefined ? Prisma.sql`` : Prisma.sql`AND status = CAST(${input.status} AS "MetricCoverageStatus")`}
    `;

    const [windows, summaryRows] = await Promise.all([
      this.prisma.resourceMetricCoverageWindow.findMany({
        where,
        orderBy: [
          { windowStart: 'asc' },
          { providerNamespace: 'asc' },
          { metricName: 'asc' },
          { statistic: 'asc' },
          { externalResourceId: 'asc' },
        ],
        take: input.limit,
      }),
      this.prisma.$queryRaw<readonly [{
        readonly total_windows: bigint;
        readonly covered_windows: bigint;
        readonly partial_windows: bigint;
        readonly no_data_windows: bigint;
        readonly failed_windows: bigint;
        readonly unknown_windows: bigint;
        readonly expected_samples: bigint;
        readonly observed_samples: bigint;
        readonly missing_samples: bigint;
      }]>`
        SELECT
          COUNT(*)::bigint AS total_windows,
          COUNT(*) FILTER (WHERE status = 'COVERED'::"MetricCoverageStatus")::bigint AS covered_windows,
          COUNT(*) FILTER (WHERE status = 'PARTIAL'::"MetricCoverageStatus")::bigint AS partial_windows,
          COUNT(*) FILTER (WHERE status = 'NO_DATA'::"MetricCoverageStatus")::bigint AS no_data_windows,
          COUNT(*) FILTER (WHERE status = 'FAILED'::"MetricCoverageStatus")::bigint AS failed_windows,
          COUNT(*) FILTER (WHERE status = 'UNKNOWN'::"MetricCoverageStatus")::bigint AS unknown_windows,
          COALESCE(SUM(expected_samples), 0)::bigint AS expected_samples,
          COALESCE(SUM(observed_samples), 0)::bigint AS observed_samples,
          COALESCE(SUM(missing_samples), 0)::bigint AS missing_samples
        FROM resource_metric_coverage_windows
        WHERE ${sqlWhere}
      `,
    ]);
    const summary = summaryRows[0];
    return {
      generatedAt: new Date(),
      connectionId: input.cloudConnectionId,
      filters: {
        ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
        ...(input.endDate === undefined ? {} : { endDate: input.endDate }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      summary: {
        totalWindows: Number(summary?.total_windows ?? 0n),
        coveredWindows: Number(summary?.covered_windows ?? 0n),
        partialWindows: Number(summary?.partial_windows ?? 0n),
        noDataWindows: Number(summary?.no_data_windows ?? 0n),
        failedWindows: Number(summary?.failed_windows ?? 0n),
        unknownWindows: Number(summary?.unknown_windows ?? 0n),
        expectedSamples: Number(summary?.expected_samples ?? 0n),
        observedSamples: Number(summary?.observed_samples ?? 0n),
        missingSamples: Number(summary?.missing_samples ?? 0n),
        returnedWindows: windows.length,
      },
      windows: windows.map((window) => ({
        id: window.id,
        cloudConnectionId: window.cloudConnectionId,
        ...(window.cloudMetricDefinitionId === null ? {} : { cloudMetricDefinitionId: window.cloudMetricDefinitionId }),
        ...(window.ingestionJobId === null ? {} : { ingestionJobId: window.ingestionJobId }),
        streamKey: window.streamKey,
        providerNamespace: window.providerNamespace,
        regionId: window.regionId,
        externalResourceId: window.externalResourceId,
        metricName: window.metricName,
        statistic: window.statistic,
        granularitySeconds: window.granularitySeconds,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        status: window.status,
        expectedSamples: window.expectedSamples,
        observedSamples: window.observedSamples,
        missingSamples: window.missingSamples,
        configurationHash: window.configurationHash,
        ...(isJsonObject(window.evidence) ? { evidence: window.evidence as Record<string, unknown> } : {}),
        ...(window.checkedAt === null ? {} : { checkedAt: window.checkedAt }),
      })),
    };
  }
}
