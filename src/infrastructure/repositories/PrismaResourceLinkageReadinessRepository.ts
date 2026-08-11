import type {
  IResourceLinkageReadinessRepository,
  ResourceLinkageReadiness,
  ResourceLinkageResourceCoverage,
  ResourceLinkageTableCoverage,
} from '../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import {
  buildResourceFreshness,
  classifyResourceEvidenceStatus,
  type ResourceFreshness,
  type ResourceLinkReasonCode,
} from '../../domain/models/ResourceLinkage.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  queryCostLinkageCoverage,
} from './queries/resourceLinkageCostQueries.js';
import { queryResourceLinkageConnections } from './queries/resourceLinkageConnectionQueries.js';
import {
  DEFAULT_REQUIRED_TAG_KEYS,
  queryResourceTagGovernance,
} from './queries/resourceTagGovernanceQueries.js';

interface CountRow {
  readonly total: bigint;
  readonly eligible: bigint;
  readonly linked: bigint;
  readonly not_eligible: bigint;
  readonly unresolved: bigint;
  readonly ambiguous: bigint;
}

interface ReasonRow {
  readonly reason: string | null;
  readonly count: bigint;
}

interface ResourceRow {
  readonly id: string;
  readonly cloud_connection_id: string;
  readonly external_resource_id: string;
  readonly provider: string;
  readonly service_name: string;
  readonly resource_type: string;
  readonly status: string;
  readonly cost_metrics: bigint;
  readonly metric_samples: bigint;
  readonly recommendations: bigint;
  readonly last_seen_at: Date;
  readonly latest_cost_at: Date | null;
  readonly latest_metric_at: Date | null;
}

interface ResourceCountRow {
  readonly with_cost: bigint;
  readonly with_metrics: bigint;
  readonly with_both: bigint;
}

interface FreshnessRow {
  readonly inventory_at: Date | null;
  readonly costs_at: Date | null;
  readonly metrics_at: Date | null;
}

const knownReasons: readonly ResourceLinkReasonCode[] = [
  'EMPTY_RESOURCE_ID',
  'INVENTORY_RESOURCE_NOT_FOUND',
  'CONNECTION_NOT_AVAILABLE',
  'AMBIGUOUS_RESOURCE_ID',
  'SERVICE_LEVEL_COST',
  'INVALID_EXISTING_REFERENCE',
  'UNSUPPORTED_RESOURCE_ID',
];

export class PrismaResourceLinkageReadinessRepository implements IResourceLinkageReadinessRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly requiredTagKeys: readonly string[] = DEFAULT_REQUIRED_TAG_KEYS,
  ) {}

  public async getForTenant(tenantId: string, resourceLimit: number): Promise<ResourceLinkageReadiness> {
    const costCoverage = await queryCostLinkageCoverage(this.prisma, tenantId);
    const cost = costCoverage.total.coverage;
    const [metric, recommendations, inventory, resources, resourceCounts, connections, freshness, latestReconciliation, tagGovernance] = await Promise.all([
      this.getMetricCoverage(tenantId),
      this.getRecommendationCoverage(tenantId),
      this.prisma.cloudResource.count({ where: { tenantId } }),
      this.getResources(tenantId, resourceLimit),
      this.getResourceCounts(tenantId),
      queryResourceLinkageConnections(this.prisma, tenantId, costCoverage.byConnection),
      this.getFreshness(tenantId),
      this.prisma.dataQualityCheck.findFirst({
        where: { tenantId, checkName: 'resource_linkage_reconciliation' },
        orderBy: { observedAt: 'desc' },
        select: { observedAt: true, status: true, details: true },
      }),
      queryResourceTagGovernance(this.prisma, tenantId, this.requiredTagKeys),
    ]);

    const linkedResourcesWithCost = Number(resourceCounts.with_cost);
    const linkedResourcesWithMetrics = Number(resourceCounts.with_metrics);
    const linkedResourcesWithBoth = Number(resourceCounts.with_both);
    const hasData = inventory > 0 || cost.total > 0 || metric.total > 0 || recommendations.total > 0;
    const technicalRecommendationBlockers = buildTechnicalRecommendationBlockers({
      inventoryResources: inventory,
      linkedResourcesWithBoth,
      cost,
      metric,
      freshness,
    });
    const hasUnresolved = cost.unresolved > 0 || metric.unresolved > 0 || recommendations.unresolved > 0;
    const hasStaleData = Object.values(freshness).some((signal) => signal.status === 'STALE');

    return {
      generatedAt: new Date(),
      status: !hasData
        ? 'NO_DATA'
        : inventory === 0 && (cost.eligible > 0 || metric.eligible > 0)
          ? 'BLOCKED'
          : hasUnresolved || hasStaleData || technicalRecommendationBlockers.length > 0 ? 'PARTIAL' : 'READY',
      inventoryResources: inventory,
      linkedResourcesWithCost,
      linkedResourcesWithMetrics,
      linkedResourcesWithBoth,
      costs: cost,
      costClassifications: costCoverage.total.classifications,
      metrics: metric,
      recommendations,
      resources,
      connections,
      tagGovernance,
      freshness,
      technicalRecommendationBlockers,
      ...(latestReconciliation !== null ? {
        latestReconciliation: {
          observedAt: latestReconciliation.observedAt,
          status: latestReconciliation.status,
          ...(isRecord(latestReconciliation.details) ? { details: latestReconciliation.details } : {}),
        },
      } : {}),
    };
  }

  private async getMetricCoverage(tenantId: string): Promise<ResourceLinkageTableCoverage> {
    const [countRows, reasonRows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT
          count(*)::bigint AS total,
          count(*)::bigint AS eligible,
          count(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked,
          0::bigint AS not_eligible,
          count(*) FILTER (WHERE cloud_resource_id IS NULL)::bigint AS unresolved
          ,count(*) FILTER (WHERE cloud_resource_id IS NULL AND resource_link_reason = 'AMBIGUOUS_RESOURCE_ID')::bigint AS ambiguous
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
          count(*) FILTER (WHERE resource_link_reason IS DISTINCT FROM 'SERVICE_LEVEL_COST' AND resource_link_reason IS DISTINCT FROM 'EMPTY_RESOURCE_ID')::bigint AS eligible,
          count(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked,
          count(*) FILTER (WHERE resource_link_reason IN ('SERVICE_LEVEL_COST', 'EMPTY_RESOURCE_ID'))::bigint AS not_eligible,
          count(*) FILTER (WHERE cloud_resource_id IS NULL AND resource_link_reason IS DISTINCT FROM 'SERVICE_LEVEL_COST' AND resource_link_reason IS DISTINCT FROM 'EMPTY_RESOURCE_ID')::bigint AS unresolved,
          count(*) FILTER (WHERE cloud_resource_id IS NULL AND resource_link_reason = 'AMBIGUOUS_RESOURCE_ID')::bigint AS ambiguous
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

  private async getFreshness(tenantId: string): Promise<ResourceFreshness> {
    const rows = await this.prisma.$queryRaw<FreshnessRow[]>(Prisma.sql`
      SELECT
        (SELECT max(last_seen_at) FROM cloud_resources WHERE tenant_id = ${tenantId}) AS inventory_at,
        (SELECT max(charge_period_end) FROM cost_metrics WHERE tenant_id = ${tenantId}) AS costs_at,
        (SELECT max(sampled_at) FROM resource_metric_samples WHERE tenant_id = ${tenantId}) AS metrics_at
    `);
    const row = rows[0];
    return buildResourceFreshness({
      inventoryAt: row?.inventory_at ?? null,
      costsAt: row?.costs_at ?? null,
      metricsAt: row?.metrics_at ?? null,
    });
  }

  private async getResources(tenantId: string, limit: number): Promise<readonly ResourceLinkageResourceCoverage[]> {
    const rows = await this.prisma.$queryRaw<ResourceRow[]>(Prisma.sql`
      WITH base_resources AS (
        SELECT id,
               cloud_connection_id,
               external_resource_id,
               provider::text AS provider,
               service_name,
               resource_type,
               status::text AS status,
               last_seen_at
        FROM cloud_resources
        WHERE tenant_id = ${tenantId}
        ORDER BY last_seen_at DESC, id ASC
        LIMIT ${limit}
      ), costs AS (
        SELECT cm.cloud_resource_id, count(*)::bigint AS count, max(cm.charge_period_end) AS latest_cost_at
        FROM cost_metrics cm
        INNER JOIN base_resources br ON br.id = cm.cloud_resource_id
        WHERE cm.tenant_id = ${tenantId}
        GROUP BY cm.cloud_resource_id
      ), metric_counts AS (
        SELECT rms.cloud_resource_id, count(*)::bigint AS count, max(rms.sampled_at) AS latest_metric_at
        FROM resource_metric_samples rms
        INNER JOIN base_resources br ON br.id = rms.cloud_resource_id
        WHERE rms.tenant_id = ${tenantId}
        GROUP BY rms.cloud_resource_id
      ), recommendation_counts AS (
        SELECT rec.cloud_resource_id, count(*)::bigint AS count
        FROM recommendations rec
        INNER JOIN base_resources br ON br.id = rec.cloud_resource_id
        WHERE rec.tenant_id = ${tenantId}
        GROUP BY rec.cloud_resource_id
      )
      SELECT
        br.id,
        br.cloud_connection_id,
        br.external_resource_id,
        br.provider,
        br.service_name,
        br.resource_type,
        br.status,
        coalesce(costs.count, 0)::bigint AS cost_metrics,
        coalesce(metric_counts.count, 0)::bigint AS metric_samples,
        coalesce(recommendation_counts.count, 0)::bigint AS recommendations,
        br.last_seen_at,
        costs.latest_cost_at,
        metric_counts.latest_metric_at
      FROM base_resources br
      LEFT JOIN costs ON costs.cloud_resource_id = br.id
      LEFT JOIN metric_counts ON metric_counts.cloud_resource_id = br.id
      LEFT JOIN recommendation_counts ON recommendation_counts.cloud_resource_id = br.id
      ORDER BY br.last_seen_at DESC, br.id ASC
    `);

    return rows.map((row) => {
      const costMetrics = Number(row.cost_metrics);
      const metricSamples = Number(row.metric_samples);
      const freshness = buildResourceFreshness({
        inventoryAt: row.last_seen_at,
        costsAt: row.latest_cost_at,
        metricsAt: row.latest_metric_at,
      });
      return {
        id: row.id,
        cloudConnectionId: row.cloud_connection_id,
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
        evidenceStatus: classifyResourceEvidenceStatus({
          costCount: costMetrics,
          metricCount: metricSamples,
          freshness,
        }),
        freshness,
        ...(row.latest_cost_at !== null ? { latestCostAt: row.latest_cost_at } : {}),
        ...(row.latest_metric_at !== null ? { latestMetricAt: row.latest_metric_at } : {}),
      } satisfies ResourceLinkageResourceCoverage;
    });
  }
}

function toCoverage(countRow: CountRow | undefined, reasonRows: readonly ReasonRow[]): ResourceLinkageTableCoverage {
  const total = Number(countRow?.total ?? 0n);
  const eligible = Number(countRow?.eligible ?? 0n);
  const linked = Number(countRow?.linked ?? 0n);
  const notEligible = Number(countRow?.not_eligible ?? 0n);
  const unresolved = Number(countRow?.unresolved ?? 0n);
  const ambiguous = Number(countRow?.ambiguous ?? 0n);
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
    notEligible,
    unresolved,
    ambiguous,
    coveragePercent: eligible === 0 ? 100 : Math.round((linked / eligible) * 10000) / 100,
    reasons,
  };
}

function buildTechnicalRecommendationBlockers(input: {
  readonly inventoryResources: number;
  readonly linkedResourcesWithBoth: number;
  readonly cost: ResourceLinkageTableCoverage;
  readonly metric: ResourceLinkageTableCoverage;
  readonly freshness: ResourceFreshness;
}): readonly string[] {
  const blockers: string[] = [];
  if (input.inventoryResources === 0 && (input.cost.eligible > 0 || input.metric.eligible > 0)) {
    blockers.push('NO_NORMALIZED_INVENTORY');
  }
  if (input.inventoryResources > 0 && input.linkedResourcesWithBoth === 0
    && (input.cost.eligible > 0 || input.metric.eligible > 0)) {
    blockers.push('NO_RESOURCE_WITH_COST_AND_TECHNICAL_EVIDENCE');
  }
  if (input.cost.unresolved > 0) blockers.push('UNLINKED_COST_EVIDENCE');
  if (input.metric.unresolved > 0) blockers.push('UNLINKED_TECHNICAL_EVIDENCE');
  if (input.freshness.inventory.status !== 'FRESH') blockers.push('INVENTORY_NOT_FRESH');
  if (input.freshness.costs.status === 'STALE') blockers.push('COST_DATA_NOT_FRESH');
  if (input.freshness.metrics.status === 'STALE') blockers.push('TECHNICAL_METRICS_NOT_FRESH');
  return blockers;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
