import type {
  CloudResourceFilters,
  CloudResourceIdentity,
  CloudResourceItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import {
  buildResourceFreshness,
  classifyResourceEvidenceStatus,
} from '../../domain/models/ResourceLinkage.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

interface CloudResourceLineageRow {
  readonly id: string;
  readonly cloud_connection_id: string;
  readonly provider: string;
  readonly external_resource_id: string;
  readonly name: string | null;
  readonly resource_type: string;
  readonly service_name: string;
  readonly region_id: string | null;
  readonly status: string;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
  readonly cost_count: bigint;
  readonly metric_count: bigint;
  readonly recommendation_count: bigint;
  readonly latest_cost_at: Date | null;
  readonly latest_metric_at: Date | null;
}

/**
 * Lee el inventario cloud y sus relaciones de evidencia sin cargar filas
 * completas de costos, métricas o recomendaciones en Node.
 */
export class PrismaCloudResourceInventoryReader {
  constructor(private readonly prisma: PrismaClient) {}

  public async listByIdentities(
    tenantId: string,
    identities: readonly CloudResourceIdentity[],
  ): Promise<readonly CloudResourceItem[]> {
    const clauses: Prisma.CloudResourceWhereInput[] = [];
    for (const identity of identities) {
      const externalResourceId = identity.externalResourceId.trim();
      if (externalResourceId === '') continue;
      clauses.push({
        externalResourceId,
        ...(identity.cloudResourceId !== undefined ? { id: identity.cloudResourceId } : {}),
        ...(identity.cloudConnectionId !== undefined ? { cloudConnectionId: identity.cloudConnectionId } : {}),
      });
    }

    if (clauses.length === 0) return [];

    const rows = await this.prisma.cloudResource.findMany({
      where: { tenantId, OR: clauses },
      orderBy: [{ name: 'asc' }, { externalResourceId: 'asc' }],
    });
    return rows.map((row) => this.toBasicItem(row));
  }

  public async listForTenant(
    tenantId: string,
    limit: number,
    filters: CloudResourceFilters = {},
  ): Promise<readonly CloudResourceItem[]> {
    const useDailyRollups = await this.hasDailyRollups(tenantId);
    const statusFilter = filters.statuses !== undefined && filters.statuses.length > 0
      ? Prisma.sql`AND status::text IN (${Prisma.join(filters.statuses)})`
      : Prisma.empty;
    const providerFilter = filters.provider === undefined
      ? Prisma.empty
      : Prisma.sql`AND provider::text = ${filters.provider}`;
    const queryFilter = filters.query === undefined
      ? Prisma.empty
      : Prisma.sql`AND (
          name ILIKE ${`%${filters.query}%`}
          OR external_resource_id ILIKE ${`%${filters.query}%`}
          OR service_name ILIKE ${`%${filters.query}%`}
          OR resource_type ILIKE ${`%${filters.query}%`}
        )`;
    const costFilter = filters.costFilter === 'WITH_COST'
      ? Prisma.sql`AND EXISTS (
          SELECT 1
            FROM cost_metrics cm_filter
           WHERE cm_filter.tenant_id = ${tenantId}
             AND cm_filter.cloud_resource_id = cloud_resources.id
             AND (cm_filter.billed_cost > 0 OR COALESCE(cm_filter.effective_cost, 0) > 0)
        )`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<CloudResourceLineageRow[]>(Prisma.sql`
      WITH base_resources AS (
        SELECT id,
               cloud_connection_id,
               provider::text AS provider,
               external_resource_id,
               name,
               resource_type,
               service_name,
               region_id,
               status::text AS status,
               first_seen_at,
               last_seen_at
          FROM cloud_resources
         WHERE tenant_id = ${tenantId}
           ${statusFilter}
           ${providerFilter}
           ${queryFilter}
           ${costFilter}
         ORDER BY last_seen_at DESC, id ASC
         LIMIT ${limit}
      ), costs AS (
        SELECT cm.cloud_resource_id,
               count(*)::bigint AS cost_count,
               max(cm.charge_period_end) AS latest_cost_at
          FROM cost_metrics cm
          INNER JOIN base_resources br ON br.id = cm.cloud_resource_id
         WHERE cm.tenant_id = ${tenantId}
         GROUP BY cm.cloud_resource_id
      ), metrics AS (
        ${useDailyRollups
          ? Prisma.sql`
        SELECT rms.cloud_resource_id,
               sum(rms.sample_count)::bigint AS metric_count,
               max(rms.latest_sampled_at) AS latest_metric_at
          FROM resource_metric_rollups rms
          INNER JOIN base_resources br ON br.id = rms.cloud_resource_id
         WHERE rms.tenant_id = ${tenantId}
           AND rms.bucket_seconds = 86400
         GROUP BY rms.cloud_resource_id
          `
          : Prisma.sql`
        SELECT rms.cloud_resource_id,
               count(*)::bigint AS metric_count,
               max(rms.sampled_at) AS latest_metric_at
          FROM resource_metric_samples rms
          INNER JOIN base_resources br ON br.id = rms.cloud_resource_id
         WHERE rms.tenant_id = ${tenantId}
         GROUP BY rms.cloud_resource_id
          `}
      ), recommendation_counts AS (
        SELECT rec.cloud_resource_id, count(*)::bigint AS recommendation_count
          FROM recommendations rec
          INNER JOIN base_resources br ON br.id = rec.cloud_resource_id
         WHERE rec.tenant_id = ${tenantId}
         GROUP BY rec.cloud_resource_id
      )
      SELECT br.id,
             br.cloud_connection_id,
             br.provider,
             br.external_resource_id,
             br.name,
             br.resource_type,
             br.service_name,
             br.region_id,
             br.status,
             br.first_seen_at,
             br.last_seen_at,
             coalesce(costs.cost_count, 0)::bigint AS cost_count,
             coalesce(metrics.metric_count, 0)::bigint AS metric_count,
             coalesce(recommendation_counts.recommendation_count, 0)::bigint AS recommendation_count,
             costs.latest_cost_at,
             metrics.latest_metric_at
        FROM base_resources br
        LEFT JOIN costs ON costs.cloud_resource_id = br.id
        LEFT JOIN metrics ON metrics.cloud_resource_id = br.id
        LEFT JOIN recommendation_counts ON recommendation_counts.cloud_resource_id = br.id
       ORDER BY br.last_seen_at DESC, br.id ASC
    `);

    return rows.map((row) => this.toItem(row));
  }

  private async hasDailyRollups(tenantId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<readonly [{ readonly exists: boolean }]>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM resource_metric_rollups
        WHERE tenant_id = ${tenantId}
          AND bucket_seconds = 86400
        LIMIT 1
      ) AS exists
    `);
    return rows[0]?.exists === true;
  }

  private toItem(row: CloudResourceLineageRow): CloudResourceItem {
    const linkedCostCount = Number(row.cost_count);
    const linkedMetricSampleCount = Number(row.metric_count);
    const freshness = buildResourceFreshness({
      inventoryAt: row.last_seen_at,
      costsAt: row.latest_cost_at,
      metricsAt: row.latest_metric_at,
    });

    return {
      id: row.id,
      cloudConnectionId: row.cloud_connection_id,
      provider: row.provider,
      externalResourceId: row.external_resource_id,
      ...(row.name !== null ? { name: row.name } : {}),
      resourceType: row.resource_type,
      serviceName: row.service_name,
      ...(row.region_id !== null ? { regionId: row.region_id } : {}),
      status: row.status as CloudResourceItem['status'],
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lineage: {
        status: classifyResourceEvidenceStatus({
          costCount: linkedCostCount,
          metricCount: linkedMetricSampleCount,
          freshness,
        }),
        linkedCostCount,
        linkedMetricSampleCount,
        linkedRecommendationCount: Number(row.recommendation_count),
        ...(row.latest_cost_at !== null ? { latestCostAt: row.latest_cost_at } : {}),
        ...(row.latest_metric_at !== null ? { latestMetricAt: row.latest_metric_at } : {}),
        freshness,
      },
    } satisfies CloudResourceItem;
  }

  private toBasicItem(row: {
    readonly id: string;
    readonly cloudConnectionId: string;
    readonly provider: string;
    readonly externalResourceId: string;
    readonly name: string | null;
    readonly resourceType: string;
    readonly serviceName: string;
    readonly regionId: string | null;
    readonly status: string;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
  }): CloudResourceItem {
    return {
      id: row.id,
      cloudConnectionId: row.cloudConnectionId,
      provider: row.provider,
      externalResourceId: row.externalResourceId,
      ...(row.name !== null ? { name: row.name } : {}),
      resourceType: row.resourceType,
      serviceName: row.serviceName,
      ...(row.regionId !== null ? { regionId: row.regionId } : {}),
      status: row.status as CloudResourceItem['status'],
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    };
  }
}
