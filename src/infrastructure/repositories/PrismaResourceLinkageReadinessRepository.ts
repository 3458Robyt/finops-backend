import type {
  IResourceLinkageReadinessRepository,
  ResourceLinkageReadiness,
  ResourceLinkageResourceCoverage,
  ResourceLinkageTableCoverage,
} from '../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import type { ResourceLinkReasonCode } from '../../domain/models/ResourceLinkage.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

interface CountRow {
  readonly total: bigint;
  readonly eligible: bigint;
  readonly linked: bigint;
  readonly unresolved: bigint;
}

interface ReasonRow {
  readonly reason: string | null;
  readonly count: bigint;
}

interface ResourceRow {
  readonly id: string;
  readonly external_resource_id: string;
  readonly provider: string;
  readonly service_name: string;
  readonly resource_type: string;
  readonly status: string;
  readonly cost_metrics: bigint;
  readonly metric_samples: bigint;
  readonly recommendations: bigint;
}

interface ResourceCountRow {
  readonly with_cost: bigint;
  readonly with_metrics: bigint;
  readonly with_both: bigint;
}

const knownReasons: readonly ResourceLinkReasonCode[] = [
  'EMPTY_RESOURCE_ID',
  'INVENTORY_RESOURCE_NOT_FOUND',
  'CONNECTION_NOT_AVAILABLE',
  'AMBIGUOUS_RESOURCE_ID',
  'SERVICE_LEVEL_COST',
  'INVALID_EXISTING_REFERENCE',
];

export class PrismaResourceLinkageReadinessRepository implements IResourceLinkageReadinessRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async getForTenant(tenantId: string, resourceLimit: number): Promise<ResourceLinkageReadiness> {
    const [cost, metric, recommendations, inventory, resources, resourceCounts, latestReconciliation] = await Promise.all([
      this.getCostCoverage(tenantId),
      this.getMetricCoverage(tenantId),
      this.getRecommendationCoverage(tenantId),
      this.prisma.cloudResource.count({ where: { tenantId } }),
      this.getResources(tenantId, resourceLimit),
      this.getResourceCounts(tenantId),
      this.prisma.dataQualityCheck.findFirst({
        where: { tenantId, checkName: 'resource_linkage_reconciliation' },
        orderBy: { observedAt: 'desc' },
        select: { observedAt: true, status: true, details: true },
      }),
    ]);

    const linkedResourcesWithCost = Number(resourceCounts.with_cost);
    const linkedResourcesWithMetrics = Number(resourceCounts.with_metrics);
    const linkedResourcesWithBoth = Number(resourceCounts.with_both);
    const hasData = inventory > 0 || cost.total > 0 || metric.total > 0 || recommendations.total > 0;
    const hasUnresolved = cost.unresolved > 0 || metric.unresolved > 0 || recommendations.unresolved > 0;

    return {
      generatedAt: new Date(),
      status: !hasData ? 'NO_DATA' : hasUnresolved ? 'PARTIAL' : 'READY',
      inventoryResources: inventory,
      linkedResourcesWithCost,
      linkedResourcesWithMetrics,
      linkedResourcesWithBoth,
      costs: cost,
      metrics: metric,
      recommendations,
      resources,
      ...(latestReconciliation !== null ? {
        latestReconciliation: {
          observedAt: latestReconciliation.observedAt,
          status: latestReconciliation.status,
          ...(isRecord(latestReconciliation.details) ? { details: latestReconciliation.details } : {}),
        },
      } : {}),
    };
  }

  private async getCostCoverage(tenantId: string): Promise<ResourceLinkageTableCoverage> {
    const [countRows, reasonRows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT
          count(*)::bigint AS total,
          count(*) FILTER (WHERE btrim(resource_id) <> '' OR cloud_resource_id IS NOT NULL)::bigint AS eligible,
          count(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked,
          count(*) FILTER (WHERE cloud_resource_id IS NULL AND btrim(resource_id) <> '')::bigint AS unresolved
        FROM cost_metrics
        WHERE tenant_id = ${tenantId}
      `),
      this.prisma.$queryRaw<ReasonRow[]>(Prisma.sql`
        SELECT resource_link_reason AS reason, count(*)::bigint AS count
        FROM cost_metrics
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NULL AND resource_link_reason IS NOT NULL
        GROUP BY resource_link_reason
      `),
    ]);
    return toCoverage(countRows[0], reasonRows);
  }

  private async getMetricCoverage(tenantId: string): Promise<ResourceLinkageTableCoverage> {
    const [countRows, reasonRows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT
          count(*)::bigint AS total,
          count(*)::bigint AS eligible,
          count(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked,
          count(*) FILTER (WHERE cloud_resource_id IS NULL)::bigint AS unresolved
        FROM resource_metric_samples
        WHERE tenant_id = ${tenantId}
      `),
      this.prisma.$queryRaw<ReasonRow[]>(Prisma.sql`
        SELECT resource_link_reason AS reason, count(*)::bigint AS count
        FROM resource_metric_samples
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NULL AND resource_link_reason IS NOT NULL
        GROUP BY resource_link_reason
      `),
    ]);
    return toCoverage(countRows[0], reasonRows);
  }

  private async getRecommendationCoverage(tenantId: string): Promise<ResourceLinkageTableCoverage> {
    const [countRows, reasonRows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT
          count(*)::bigint AS total,
          count(*) FILTER (WHERE resource_link_reason IS DISTINCT FROM 'SERVICE_LEVEL_COST')::bigint AS eligible,
          count(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked,
          count(*) FILTER (WHERE cloud_resource_id IS NULL AND resource_link_reason IS DISTINCT FROM 'SERVICE_LEVEL_COST')::bigint AS unresolved
        FROM recommendations
        WHERE tenant_id = ${tenantId}
      `),
      this.prisma.$queryRaw<ReasonRow[]>(Prisma.sql`
        SELECT resource_link_reason AS reason, count(*)::bigint AS count
        FROM recommendations
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NULL AND resource_link_reason IS NOT NULL
        GROUP BY resource_link_reason
      `),
    ]);
    return toCoverage(countRows[0], reasonRows);
  }

  private async getResourceCounts(tenantId: string): Promise<ResourceCountRow> {
    const rows = await this.prisma.$queryRaw<ResourceCountRow[]>(Prisma.sql`
      WITH cost_resources AS (
        SELECT DISTINCT cloud_resource_id
        FROM cost_metrics
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NOT NULL
      ), metric_resources AS (
        SELECT DISTINCT cloud_resource_id
        FROM resource_metric_samples
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NOT NULL
      )
      SELECT
        (SELECT count(*)::bigint FROM cost_resources) AS with_cost,
        (SELECT count(*)::bigint FROM metric_resources) AS with_metrics,
        (SELECT count(*)::bigint FROM cost_resources c INNER JOIN metric_resources m USING (cloud_resource_id)) AS with_both
    `);
    return rows[0] ?? { with_cost: 0n, with_metrics: 0n, with_both: 0n };
  }

  private async getResources(tenantId: string, limit: number): Promise<readonly ResourceLinkageResourceCoverage[]> {
    const rows = await this.prisma.$queryRaw<ResourceRow[]>(Prisma.sql`
      WITH costs AS (
        SELECT cloud_resource_id, count(*)::bigint AS count
        FROM cost_metrics
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NOT NULL
        GROUP BY cloud_resource_id
      ), metric_counts AS (
        SELECT cloud_resource_id, count(*)::bigint AS count
        FROM resource_metric_samples
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NOT NULL
        GROUP BY cloud_resource_id
      ), recommendation_counts AS (
        SELECT cloud_resource_id, count(*)::bigint AS count
        FROM recommendations
        WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NOT NULL
        GROUP BY cloud_resource_id
      )
      SELECT
        cr.id,
        cr.external_resource_id,
        cr.provider::text AS provider,
        cr.service_name,
        cr.resource_type,
        cr.status::text AS status,
        coalesce(costs.count, 0)::bigint AS cost_metrics,
        coalesce(metric_counts.count, 0)::bigint AS metric_samples,
        coalesce(recommendation_counts.count, 0)::bigint AS recommendations
      FROM cloud_resources cr
      LEFT JOIN costs ON costs.cloud_resource_id = cr.id
      LEFT JOIN metric_counts ON metric_counts.cloud_resource_id = cr.id
      LEFT JOIN recommendation_counts ON recommendation_counts.cloud_resource_id = cr.id
      WHERE cr.tenant_id = ${tenantId}
      ORDER BY cr.last_seen_at DESC, cr.id ASC
      LIMIT ${limit}
    `);

    return rows.map((row) => {
      const costMetrics = Number(row.cost_metrics);
      const metricSamples = Number(row.metric_samples);
      return {
        id: row.id,
        externalResourceId: row.external_resource_id,
        provider: row.provider,
        serviceName: row.service_name,
        resourceType: row.resource_type,
        status: row.status,
        costMetrics,
        metricSamples,
        recommendations: Number(row.recommendations),
        coverage: costMetrics > 0 && metricSamples > 0
          ? 'COST_AND_TECHNICAL'
          : costMetrics > 0 ? 'COST_ONLY'
            : metricSamples > 0 ? 'TECHNICAL_ONLY' : 'INVENTORY_ONLY',
      } satisfies ResourceLinkageResourceCoverage;
    });
  }
}

function toCoverage(countRow: CountRow | undefined, reasonRows: readonly ReasonRow[]): ResourceLinkageTableCoverage {
  const total = Number(countRow?.total ?? 0n);
  const eligible = Number(countRow?.eligible ?? 0n);
  const linked = Number(countRow?.linked ?? 0n);
  const unresolved = Number(countRow?.unresolved ?? 0n);
  const reasons: Partial<Record<ResourceLinkReasonCode, number>> = {};
  for (const row of reasonRows) {
    if (row.reason !== null && knownReasons.includes(row.reason as ResourceLinkReasonCode)) {
      reasons[row.reason as ResourceLinkReasonCode] = Number(row.count);
    }
  }
  return {
    total,
    eligible,
    linked,
    unresolved,
    coveragePercent: eligible === 0 ? 100 : Math.round((linked / eligible) * 10000) / 100,
    reasons,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
