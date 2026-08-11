import type { NormalizedCloudResource } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { insertHistoricalCloudResources } from './PrismaCloudResourceCatalog.js';
import { classifySupportedOciResourceId } from './oci/OciHistoricalResourceCatalog.js';

type HistoricalBackfillClient = Pick<PrismaClient, '$queryRaw' | 'cloudResource'>;

interface HistoricalCostResourceRow {
  readonly cloud_connection_id: string;
  readonly resource_id: string;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
  readonly service_name: string;
  readonly region_id: string | null;
}

export interface HistoricalOciResourceBackfillResult {
  readonly mode: 'APPLY' | 'DRY_RUN';
  readonly examined: number;
  readonly candidates: number;
  readonly inserted: number;
  readonly batches: number;
  readonly byResourceType: Readonly<Record<string, number>>;
}

export async function backfillHistoricalOciResources(
  prisma: HistoricalBackfillClient,
  tenantId: string,
  batchSize: number,
  apply: boolean,
): Promise<HistoricalOciResourceBackfillResult> {
  let cursor: { readonly connectionId: string; readonly resourceId: string } | undefined;
  let examined = 0;
  let candidates = 0;
  let inserted = 0;
  let batches = 0;
  const byResourceType: Record<string, number> = {};

  while (true) {
    const rows = await prisma.$queryRaw<HistoricalCostResourceRow[]>(Prisma.sql`
      SELECT
        cm.cloud_connection_id,
        cm.resource_id,
        min(cm.charge_period_start) AS first_seen_at,
        max(cm.charge_period_end) AS last_seen_at,
        min(cm.service_name) AS service_name,
        max(cm.region_id) AS region_id
      FROM cost_metrics cm
      LEFT JOIN cloud_resources cr
        ON cr.cloud_connection_id = cm.cloud_connection_id
       AND cr.external_resource_id = cm.resource_id
      WHERE cm.tenant_id = ${tenantId}
        AND cm.provider = 'OCI'::"CloudProvider"
        AND cm.cloud_connection_id IS NOT NULL
        AND cm.resource_id ~* '^ocid1\\.(instance|bootvolume|bootvolumebackup|vnic)\\.'
        AND cr.id IS NULL
        ${cursor === undefined ? Prisma.empty : Prisma.sql`
          AND (cm.cloud_connection_id, cm.resource_id) > (${cursor.connectionId}, ${cursor.resourceId})
        `}
      GROUP BY cm.cloud_connection_id, cm.resource_id
      ORDER BY cm.cloud_connection_id, cm.resource_id
      LIMIT ${batchSize}
    `);
    if (rows.length === 0) break;
    batches += 1;
    examined += rows.length;
    const resources = rows.flatMap((row) => toHistoricalResource(tenantId, row));
    candidates += resources.length;
    for (const resource of resources) {
      byResourceType[resource.resourceType] = (byResourceType[resource.resourceType] ?? 0) + 1;
    }
    if (apply) inserted += await insertHistoricalCloudResources(prisma, resources);
    const last = rows.at(-1)!;
    cursor = { connectionId: last.cloud_connection_id, resourceId: last.resource_id };
    if (rows.length < batchSize) break;
  }

  return {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    examined,
    candidates,
    inserted,
    batches,
    byResourceType,
  };
}

function toHistoricalResource(
  tenantId: string,
  row: HistoricalCostResourceRow,
): readonly NormalizedCloudResource[] {
  const catalog = classifySupportedOciResourceId(row.resource_id);
  if (catalog === undefined) return [];
  return [{
    tenantId,
    cloudConnectionId: row.cloud_connection_id,
    provider: 'OCI',
    externalResourceId: row.resource_id,
    name: row.resource_id,
    resourceType: catalog.resourceType,
    serviceName: catalog.serviceName,
    ...(row.region_id !== null ? { regionId: row.region_id } : {}),
    status: 'UNKNOWN',
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    rawResource: {
      source: 'OCI_FOCUS_HISTORICAL_REFERENCE',
      normalizerVersion: 'oci-focus-history-v1',
      historicalReference: true,
      observedServiceName: row.service_name,
      evidencePeriodStart: row.first_seen_at.toISOString(),
      evidencePeriodEnd: row.last_seen_at.toISOString(),
    },
  }];
}
