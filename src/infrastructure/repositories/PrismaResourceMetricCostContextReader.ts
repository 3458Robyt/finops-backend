import type { TechnicalCostContextItem } from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

/** Reads tenant-scoped billing context for exact technical resource IDs. */
export class PrismaResourceMetricCostContextReader {
  constructor(private readonly prisma: PrismaClient) {}

  public async listForResources(
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
}
