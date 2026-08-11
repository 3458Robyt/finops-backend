import type {
  CostResourceClassification,
  CostResourceClassificationSummary,
  ResourceLinkageTableCoverage,
} from '../../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import type { ResourceLinkReasonCode } from '../../../domain/models/ResourceLinkage.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { Prisma } from '../../../generated/prisma/client.js';

export interface CostClassificationRow {
  readonly cloud_connection_id: string | null;
  readonly service_name: string;
  readonly classification: CostResourceClassification;
  readonly count: bigint;
}

export interface CostLinkageCoverageResult {
  readonly coverage: ResourceLinkageTableCoverage;
  readonly classifications: CostResourceClassificationSummary;
}

export interface CostLinkageCoverageByConnection {
  readonly total: CostLinkageCoverageResult;
  readonly byConnection: ReadonlyMap<string, CostLinkageCoverageResult>;
}

const classifications: readonly CostResourceClassification[] = [
  'RESOURCE_FOUND',
  'HISTORICAL_RESOURCE',
  'SERVICE_OR_ACCOUNT_LEVEL',
  'CONNECTION_NOT_AVAILABLE',
  'INVALID_OR_UNSUPPORTED_ID',
  'INVENTORY_RESOURCE_NOT_FOUND',
  'AMBIGUOUS_RESOURCE_ID',
];

export async function queryCostLinkageCoverage(
  prisma: PrismaClient,
  tenantId: string,
): Promise<CostLinkageCoverageByConnection> {
  const rows = await prisma.$queryRaw<CostClassificationRow[]>(Prisma.sql`
    WITH classified AS (
      SELECT
        cm.cloud_connection_id,
        cm.service_name,
        CASE
          WHEN cm.cloud_resource_id IS NOT NULL
            AND COALESCE(cr.raw_resource ->> 'historicalReference', 'false') = 'true'
            THEN 'HISTORICAL_RESOURCE'
          WHEN cm.cloud_resource_id IS NOT NULL THEN 'RESOURCE_FOUND'
          WHEN btrim(cm.resource_id) = ''
            OR cm.resource_link_reason IN ('SERVICE_LEVEL_COST', 'EMPTY_RESOURCE_ID')
            THEN 'SERVICE_OR_ACCOUNT_LEVEL'
          WHEN cm.cloud_connection_id IS NULL
            OR cm.resource_link_reason = 'CONNECTION_NOT_AVAILABLE'
            THEN 'CONNECTION_NOT_AVAILABLE'
          WHEN cm.resource_link_reason IN ('INVALID_EXISTING_REFERENCE', 'UNSUPPORTED_RESOURCE_ID')
            THEN 'INVALID_OR_UNSUPPORTED_ID'
          WHEN cm.provider = 'OCI'::"CloudProvider"
            AND cm.resource_id !~* '^ocid1\\.(instance|bootvolume|bootvolumebackup|vnic)\\.'
            THEN 'INVALID_OR_UNSUPPORTED_ID'
          WHEN cm.resource_link_reason = 'AMBIGUOUS_RESOURCE_ID' THEN 'AMBIGUOUS_RESOURCE_ID'
          ELSE 'INVENTORY_RESOURCE_NOT_FOUND'
        END AS classification
      FROM cost_metrics cm
      LEFT JOIN cloud_resources cr
        ON cr.id = cm.cloud_resource_id
       AND cr.tenant_id = cm.tenant_id
      WHERE cm.tenant_id = ${tenantId}
    )
    SELECT cloud_connection_id, service_name, classification, count(*)::bigint AS count
    FROM classified
    GROUP BY cloud_connection_id, service_name, classification
  `);
  const byConnectionRows = new Map<string, CostClassificationRow[]>();
  for (const row of rows) {
    if (row.cloud_connection_id === null) continue;
    const current = byConnectionRows.get(row.cloud_connection_id) ?? [];
    current.push(row);
    byConnectionRows.set(row.cloud_connection_id, current);
  }
  return {
    total: buildCostLinkageCoverage(rows),
    byConnection: new Map([...byConnectionRows].map(([id, values]) => [id, buildCostLinkageCoverage(values)])),
  };
}

export function buildCostLinkageCoverage(
  rows: readonly CostClassificationRow[],
): CostLinkageCoverageResult {
  const counts = countClassifications(rows);
  const linked = counts.RESOURCE_FOUND + counts.HISTORICAL_RESOURCE;
  const unresolved = counts.INVENTORY_RESOURCE_NOT_FOUND + counts.AMBIGUOUS_RESOURCE_ID;
  const eligible = linked + unresolved;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const reasons: Partial<Record<ResourceLinkReasonCode, number>> = {};
  addReason(reasons, 'SERVICE_LEVEL_COST', counts.SERVICE_OR_ACCOUNT_LEVEL);
  addReason(reasons, 'CONNECTION_NOT_AVAILABLE', counts.CONNECTION_NOT_AVAILABLE);
  addReason(reasons, 'UNSUPPORTED_RESOURCE_ID', counts.INVALID_OR_UNSUPPORTED_ID);
  addReason(reasons, 'INVENTORY_RESOURCE_NOT_FOUND', counts.INVENTORY_RESOURCE_NOT_FOUND);
  addReason(reasons, 'AMBIGUOUS_RESOURCE_ID', counts.AMBIGUOUS_RESOURCE_ID);
  return {
    coverage: {
      total,
      eligible,
      linked,
      notEligible: total - eligible,
      unresolved,
      ambiguous: counts.AMBIGUOUS_RESOURCE_ID,
      coveragePercent: percentage(linked, eligible),
      reasons,
    },
    classifications: {
      counts,
      byService: [...groupByService(rows)].map(([serviceName, serviceRows]) => {
        const serviceCounts = countClassifications(serviceRows);
        const serviceLinked = serviceCounts.RESOURCE_FOUND + serviceCounts.HISTORICAL_RESOURCE;
        const serviceUnresolved = serviceCounts.INVENTORY_RESOURCE_NOT_FOUND + serviceCounts.AMBIGUOUS_RESOURCE_ID;
        const serviceEligible = serviceLinked + serviceUnresolved;
        return {
          serviceName,
          total: Object.values(serviceCounts).reduce((sum, value) => sum + value, 0),
          eligible: serviceEligible,
          linked: serviceLinked,
          coveragePercent: percentage(serviceLinked, serviceEligible),
          counts: serviceCounts,
        };
      }).sort((left, right) => right.total - left.total || left.serviceName.localeCompare(right.serviceName)),
    },
  };
}

function countClassifications(rows: readonly CostClassificationRow[]): Record<CostResourceClassification, number> {
  const counts = Object.fromEntries(classifications.map((code) => [code, 0])) as Record<CostResourceClassification, number>;
  for (const row of rows) counts[row.classification] += Number(row.count);
  return counts;
}

function groupByService(rows: readonly CostClassificationRow[]): ReadonlyMap<string, readonly CostClassificationRow[]> {
  const grouped = new Map<string, CostClassificationRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.service_name) ?? [];
    current.push(row);
    grouped.set(row.service_name, current);
  }
  return grouped;
}

function addReason(
  reasons: Partial<Record<ResourceLinkReasonCode, number>>,
  reason: ResourceLinkReasonCode,
  count: number,
): void {
  if (count > 0) reasons[reason] = count;
}

function percentage(linked: number, eligible: number): number {
  return eligible === 0 ? 100 : Math.round((linked / eligible) * 10000) / 100;
}
