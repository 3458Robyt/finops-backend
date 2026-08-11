import type {
  ResourceLinkageConnectionReadiness,
  ResourceLinkageReadiness,
  ResourceLinkageTableCoverage,
} from '../../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import {
  buildResourceFreshness,
  type ResourceFreshness,
  type ResourceLinkReasonCode,
} from '../../../domain/models/ResourceLinkage.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { buildCostLinkageCoverage, type CostLinkageCoverageResult } from './resourceLinkageCostQueries.js';

interface ConnectionRow {
  readonly cloud_connection_id: string;
  readonly total: bigint;
  readonly eligible: bigint;
  readonly linked: bigint;
  readonly not_eligible: bigint;
  readonly unresolved: bigint;
  readonly ambiguous: bigint;
}

interface ConnectionReasonRow {
  readonly cloud_connection_id: string;
  readonly reason: string | null;
  readonly count: bigint;
}

interface ConnectionFreshnessRow {
  readonly cloud_connection_id: string;
  readonly inventory_at: Date | null;
  readonly costs_at: Date | null;
  readonly metrics_at: Date | null;
}

const knownReasons: readonly ResourceLinkReasonCode[] = [
  'EMPTY_RESOURCE_ID', 'INVENTORY_RESOURCE_NOT_FOUND', 'CONNECTION_NOT_AVAILABLE',
  'AMBIGUOUS_RESOURCE_ID', 'SERVICE_LEVEL_COST', 'INVALID_EXISTING_REFERENCE', 'UNSUPPORTED_RESOURCE_ID',
];

export async function queryResourceLinkageConnections(
  prisma: PrismaClient,
  tenantId: string,
  costCoverageByConnection: ReadonlyMap<string, CostLinkageCoverageResult>,
): Promise<readonly ResourceLinkageConnectionReadiness[]> {
  const [connections, inventoryRows, metricRows, metricReasons, recommendationRows, connectionFreshnessRows] = await Promise.all([
    prisma.cloudConnection.findMany({
      where: { tenantId },
      select: { id: true, name: true, providerCode: true },
      orderBy: { name: 'asc' },
    }),
    prisma.$queryRaw<Array<{ readonly cloud_connection_id: string; readonly count: bigint }>>(Prisma.sql`
      SELECT cloud_connection_id, count(*)::bigint AS count
      FROM cloud_resources WHERE tenant_id = ${tenantId}
      GROUP BY cloud_connection_id
    `),
    prisma.$queryRaw<ConnectionRow[]>(Prisma.sql`
      SELECT cloud_connection_id,
        count(*)::bigint AS total, count(*)::bigint AS eligible,
        count(*) FILTER (WHERE cloud_resource_id IS NOT NULL)::bigint AS linked,
        0::bigint AS not_eligible,
        count(*) FILTER (WHERE cloud_resource_id IS NULL)::bigint AS unresolved,
        count(*) FILTER (WHERE cloud_resource_id IS NULL AND resource_link_reason = 'AMBIGUOUS_RESOURCE_ID')::bigint AS ambiguous
      FROM resource_metric_samples WHERE tenant_id = ${tenantId}
      GROUP BY cloud_connection_id
    `),
    prisma.$queryRaw<ConnectionReasonRow[]>(Prisma.sql`
      SELECT cloud_connection_id, resource_link_reason AS reason, count(*)::bigint AS count
      FROM resource_metric_samples
      WHERE tenant_id = ${tenantId} AND cloud_resource_id IS NULL AND resource_link_reason IS NOT NULL
      GROUP BY cloud_connection_id, resource_link_reason
    `),
    prisma.$queryRaw<ConnectionRow[]>(Prisma.sql`
      SELECT cr.cloud_connection_id,
        count(*)::bigint AS total, count(*)::bigint AS eligible,
        count(*) FILTER (WHERE rec.cloud_resource_id IS NOT NULL)::bigint AS linked,
        0::bigint AS not_eligible, 0::bigint AS unresolved, 0::bigint AS ambiguous
      FROM recommendations rec
      INNER JOIN cloud_resources cr ON cr.id = rec.cloud_resource_id AND cr.tenant_id = rec.tenant_id
      WHERE rec.tenant_id = ${tenantId} AND rec.cloud_resource_id IS NOT NULL
      GROUP BY cr.cloud_connection_id
    `),
    prisma.$queryRaw<ConnectionFreshnessRow[]>(Prisma.sql`
      SELECT cloud_connection_id, max(inventory_at) AS inventory_at,
        max(costs_at) AS costs_at, max(metrics_at) AS metrics_at
      FROM (
        SELECT cloud_connection_id, max(last_seen_at) AS inventory_at,
          NULL::timestamptz AS costs_at, NULL::timestamptz AS metrics_at
        FROM cloud_resources WHERE tenant_id = ${tenantId} GROUP BY cloud_connection_id
        UNION ALL
        SELECT cloud_connection_id, NULL::timestamptz, max(charge_period_end), NULL::timestamptz
        FROM cost_metrics WHERE tenant_id = ${tenantId} AND cloud_connection_id IS NOT NULL GROUP BY cloud_connection_id
        UNION ALL
        SELECT cloud_connection_id, NULL::timestamptz, NULL::timestamptz, max(sampled_at)
        FROM resource_metric_samples WHERE tenant_id = ${tenantId} GROUP BY cloud_connection_id
      ) source_dates GROUP BY cloud_connection_id
    `),
  ]);

  const inventoryByConnection = new Map(inventoryRows.map((row) => [row.cloud_connection_id, Number(row.count)]));
  const freshnessByConnection = new Map(connectionFreshnessRows.map((row) => [row.cloud_connection_id, buildResourceFreshness({
    inventoryAt: row.inventory_at,
    costsAt: row.costs_at,
    metricsAt: row.metrics_at,
  })]));

  return connections.map((connection) => {
    const costResult = costCoverageByConnection.get(connection.id) ?? buildCostLinkageCoverage([]);
    const metrics = toConnectionCoverage(connection.id, metricRows, metricReasons);
    const recommendations = toConnectionCoverage(connection.id, recommendationRows, []);
    const inventoryResources = inventoryByConnection.get(connection.id) ?? 0;
    const freshness = freshnessByConnection.get(connection.id) ?? buildResourceFreshness({});
    return {
      id: connection.id,
      name: connection.name,
      provider: connection.providerCode,
      inventoryResources,
      costs: costResult.coverage,
      costClassifications: costResult.classifications,
      metrics,
      recommendations,
      freshness,
      status: getReadinessStatus({ inventoryResources, costs: costResult.coverage, metrics, recommendations, freshness }),
    } satisfies ResourceLinkageConnectionReadiness;
  });
}

function toConnectionCoverage(
  connectionId: string,
  rows: readonly ConnectionRow[],
  reasonRows: readonly ConnectionReasonRow[],
): ResourceLinkageTableCoverage {
  const row = rows.find((candidate) => candidate.cloud_connection_id === connectionId);
  const reasons: Partial<Record<ResourceLinkReasonCode, number>> = {};
  for (const reasonRow of reasonRows) {
    if (reasonRow.cloud_connection_id === connectionId
      && reasonRow.reason !== null
      && knownReasons.includes(reasonRow.reason as ResourceLinkReasonCode)) {
      reasons[reasonRow.reason as ResourceLinkReasonCode] = Number(reasonRow.count);
    }
  }
  const total = Number(row?.total ?? 0n);
  const eligible = Number(row?.eligible ?? 0n);
  const linked = Number(row?.linked ?? 0n);
  return {
    total,
    eligible,
    linked,
    notEligible: Number(row?.not_eligible ?? 0n),
    unresolved: Number(row?.unresolved ?? 0n),
    ambiguous: Number(row?.ambiguous ?? 0n),
    coveragePercent: eligible === 0 ? 100 : Math.round((linked / eligible) * 10000) / 100,
    reasons,
  };
}

function getReadinessStatus(input: {
  readonly inventoryResources: number;
  readonly costs: ResourceLinkageTableCoverage;
  readonly metrics: ResourceLinkageTableCoverage;
  readonly recommendations: ResourceLinkageTableCoverage;
  readonly freshness: ResourceFreshness;
}): ResourceLinkageReadiness['status'] {
  const hasData = input.inventoryResources > 0 || input.costs.total > 0
    || input.metrics.total > 0 || input.recommendations.total > 0;
  if (!hasData) return 'NO_DATA';
  if (input.inventoryResources === 0 && (input.costs.eligible > 0 || input.metrics.eligible > 0)) return 'BLOCKED';
  const hasUnresolved = input.costs.unresolved > 0 || input.metrics.unresolved > 0 || input.recommendations.unresolved > 0;
  const hasStale = Object.values(input.freshness).some((signal) => signal.status === 'STALE');
  return hasUnresolved || hasStale ? 'PARTIAL' : 'READY';
}
