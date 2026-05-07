import type {
  AnalyticsFilters,
  CostAnomaly,
  CostAnalyticsAccountItem,
  CostAnalyticsEnvironmentItem,
  CostAnalyticsProviderItem,
  CostAnalyticsResourceItem,
  CostAnalyticsServiceItem,
  CostAnalyticsSnapshot,
  CostAnalyticsUsageItem,
  CostForecast,
  ICostAnalyticsRepository,
  MonthlyCostPoint,
  MonthlyUsagePoint,
  PersistCostAnomalyInput,
  PersistCostForecastInput,
} from '../../domain/interfaces/ICostAnalyticsRepository.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

interface ProviderRow {
  readonly provider: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

interface AccountRow {
  readonly cloud_account_id: string;
  readonly provider: string;
  readonly name: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

interface ServiceRow {
  readonly service_name: string;
  readonly provider: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

interface EnvironmentRow {
  readonly environment: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

interface ResourceRow {
  readonly resource_id: string;
  readonly service_name: string;
  readonly provider: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

interface CurrencyRow {
  readonly currency: string;
}

interface MonthlyCostRow {
  readonly month: Date;
  readonly group_by: string;
  readonly group_key: string;
  readonly provider: string | null;
  readonly cloud_account_id: string | null;
  readonly service_name: string | null;
  readonly resource_id: string | null;
  readonly environment: string | null;
  readonly currency: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

interface MonthlyUsageRow {
  readonly month: Date;
  readonly group_by: string;
  readonly group_key: string;
  readonly provider: string | null;
  readonly cloud_account_id: string | null;
  readonly service_name: string | null;
  readonly resource_id: string | null;
  readonly environment: string | null;
  readonly consumed_unit: string;
  readonly currency: string;
  readonly metric_count: number;
  readonly consumed_quantity: number;
  readonly total_cost: number;
}

interface TopUsageRow {
  readonly service_name: string;
  readonly provider: string;
  readonly consumed_unit: string;
  readonly currency: string;
  readonly metric_count: number;
  readonly consumed_quantity: number;
  readonly total_cost: number;
}

export class PrismaCostAnalyticsRepository implements ICostAnalyticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async getLatestTenantSnapshot(tenantId: string): Promise<CostAnalyticsSnapshot> {
    const bounds = await this.prisma.costMetric.aggregate({
      where: { tenantId },
      _max: { chargePeriodStart: true },
    });

    const latestMetricDate = bounds._max.chargePeriodStart;

    if (latestMetricDate === null) {
      return this.emptySnapshot(tenantId);
    }

    const periodStart = new Date(Date.UTC(
      latestMetricDate.getUTCFullYear(),
      latestMetricDate.getUTCMonth(),
      1,
    ));
    const periodEnd = new Date(Date.UTC(
      latestMetricDate.getUTCFullYear(),
      latestMetricDate.getUTCMonth() + 1,
      1,
    ));

    const [summary, currencies, providers, accounts, services, environments, topResources, topUsage] = await Promise.all([
      this.prisma.costMetric.aggregate({
        where: {
          tenantId,
          chargePeriodStart: {
            gte: periodStart,
            lt: periodEnd,
          },
        },
        _count: true,
        _sum: {
          billedCost: true,
        },
      }),
      this.prisma.$queryRaw<CurrencyRow[]>`
        select billing_currency as currency
        from cost_metrics
        where tenant_id = ${tenantId}
          and charge_period_start >= ${periodStart}
          and charge_period_start < ${periodEnd}
        group by billing_currency
        order by count(*) desc
        limit 1
      `,
      this.prisma.$queryRaw<ProviderRow[]>`
        select provider::text as provider,
               count(*)::int as metric_count,
               coalesce(sum(billed_cost), 0)::float8 as total_cost
        from cost_metrics
        where tenant_id = ${tenantId}
          and charge_period_start >= ${periodStart}
          and charge_period_start < ${periodEnd}
        group by provider
        order by total_cost desc
      `,
      this.prisma.$queryRaw<AccountRow[]>`
        select cm.cloud_account_id,
               cm.provider::text as provider,
               max(ca.name) as name,
               count(*)::int as metric_count,
               coalesce(sum(cm.billed_cost), 0)::float8 as total_cost
        from cost_metrics cm
        inner join cloud_accounts ca on ca.id = cm.cloud_account_id
        where cm.tenant_id = ${tenantId}
          and cm.charge_period_start >= ${periodStart}
          and cm.charge_period_start < ${periodEnd}
        group by cm.cloud_account_id, cm.provider
        order by total_cost desc
      `,
      this.prisma.$queryRaw<ServiceRow[]>`
        select service_name,
               provider::text as provider,
               count(*)::int as metric_count,
               coalesce(sum(billed_cost), 0)::float8 as total_cost
        from cost_metrics
        where tenant_id = ${tenantId}
          and charge_period_start >= ${periodStart}
          and charge_period_start < ${periodEnd}
        group by service_name, provider
        order by total_cost desc
        limit 10
      `,
      this.prisma.$queryRaw<EnvironmentRow[]>`
        select coalesce(tags->>'environment', 'unknown') as environment,
               count(*)::int as metric_count,
               coalesce(sum(billed_cost), 0)::float8 as total_cost
        from cost_metrics
        where tenant_id = ${tenantId}
          and charge_period_start >= ${periodStart}
          and charge_period_start < ${periodEnd}
        group by coalesce(tags->>'environment', 'unknown')
        order by total_cost desc
      `,
      this.prisma.$queryRaw<ResourceRow[]>`
        select resource_id,
               max(service_name) as service_name,
               max(provider::text) as provider,
               count(*)::int as metric_count,
               coalesce(sum(billed_cost), 0)::float8 as total_cost
        from cost_metrics
        where tenant_id = ${tenantId}
          and charge_period_start >= ${periodStart}
          and charge_period_start < ${periodEnd}
          and resource_id <> ''
        group by resource_id
        order by total_cost desc
        limit 10
      `,
      this.prisma.$queryRaw<TopUsageRow[]>`
        select service_name,
               provider::text as provider,
               consumed_unit,
               max(billing_currency) as currency,
               count(*)::int as metric_count,
               coalesce(sum(consumed_quantity), 0)::float8 as consumed_quantity,
               coalesce(sum(billed_cost), 0)::float8 as total_cost
        from cost_metrics
        where tenant_id = ${tenantId}
          and charge_period_start >= ${periodStart}
          and charge_period_start < ${periodEnd}
          and consumed_quantity is not null
          and consumed_unit is not null
          and consumed_unit <> ''
        group by service_name, provider, consumed_unit
        order by total_cost desc, consumed_quantity desc
        limit 10
      `,
    ]);

    const [anomalies, forecasts] = await Promise.all([
      this.findAnomalies(tenantId),
      this.findForecasts(tenantId),
    ]);

    return {
      tenantId,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      totalCost: Number(summary._sum.billedCost ?? 0),
      currency: currencies[0]?.currency ?? 'USD',
      metricCount: summary._count,
      providers: providers.map(this.toProviderItem),
      accounts: accounts.map(this.toAccountItem),
      services: services.map(this.toServiceItem),
      environments: environments.map(this.toEnvironmentItem),
      topResources: topResources.map(this.toResourceItem),
      topUsage: topUsage.map(this.toUsageItem),
      anomalies: anomalies.slice(0, 5),
      forecasts: forecasts.slice(0, 6),
    };
  }

  public async getMonthlyCostSeries(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<MonthlyCostPoint[]> {
    const groupBy = filters.groupBy ?? 'service';
    const groupExpression = this.groupExpression(groupBy);
    const clauses: Prisma.Sql[] = [Prisma.sql`tenant_id = ${tenantId}`];

    if (filters.from !== undefined) {
      clauses.push(Prisma.sql`charge_period_start >= ${filters.from}`);
    }

    if (filters.to !== undefined) {
      clauses.push(Prisma.sql`charge_period_start < ${filters.to}`);
    }

    if (filters.provider !== undefined) {
      clauses.push(Prisma.sql`provider::text = ${filters.provider}`);
    }

    if (filters.cloudAccountId !== undefined) {
      clauses.push(Prisma.sql`cloud_account_id = ${filters.cloudAccountId}`);
    }

    if (filters.serviceName !== undefined) {
      clauses.push(Prisma.sql`service_name = ${filters.serviceName}`);
    }

    const rows = await this.prisma.$queryRaw<MonthlyCostRow[]>`
      select date_trunc('month', charge_period_start)::timestamptz as month,
             ${groupBy} as group_by,
             ${groupExpression} as group_key,
             max(provider::text) as provider,
             max(cloud_account_id) as cloud_account_id,
             max(service_name) as service_name,
             nullif(max(resource_id), '') as resource_id,
             max(coalesce(tags->>'environment', 'unknown')) as environment,
             max(billing_currency) as currency,
             count(*)::int as metric_count,
             coalesce(sum(billed_cost), 0)::float8 as total_cost
      from cost_metrics
      where ${Prisma.join(clauses, ' and ')}
      group by date_trunc('month', charge_period_start), ${groupExpression}
      order by month asc, total_cost desc
    `;

    return rows.map((row) => ({
      month: row.month.toISOString(),
      groupBy,
      groupKey: row.group_key,
      ...(row.provider !== null ? { provider: row.provider } : {}),
      ...(row.cloud_account_id !== null ? { cloudAccountId: row.cloud_account_id } : {}),
      ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
      ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
      ...(row.environment !== null ? { environment: row.environment } : {}),
      cost: row.total_cost,
      currency: row.currency,
      metricCount: row.metric_count,
    }));
  }

  public async getMonthlyUsageSeries(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<MonthlyUsagePoint[]> {
    const groupBy = filters.groupBy ?? 'service';
    const groupExpression = this.groupExpression(groupBy);
    const clauses: Prisma.Sql[] = [
      Prisma.sql`tenant_id = ${tenantId}`,
      Prisma.sql`consumed_quantity is not null`,
      Prisma.sql`consumed_unit is not null`,
      Prisma.sql`consumed_unit <> ''`,
    ];

    if (filters.from !== undefined) {
      clauses.push(Prisma.sql`charge_period_start >= ${filters.from}`);
    }

    if (filters.to !== undefined) {
      clauses.push(Prisma.sql`charge_period_start < ${filters.to}`);
    }

    if (filters.provider !== undefined) {
      clauses.push(Prisma.sql`provider::text = ${filters.provider}`);
    }

    if (filters.cloudAccountId !== undefined) {
      clauses.push(Prisma.sql`cloud_account_id = ${filters.cloudAccountId}`);
    }

    if (filters.serviceName !== undefined) {
      clauses.push(Prisma.sql`service_name = ${filters.serviceName}`);
    }

    const rows = await this.prisma.$queryRaw<MonthlyUsageRow[]>`
      select date_trunc('month', charge_period_start)::timestamptz as month,
             ${groupBy} as group_by,
             ${groupExpression} as group_key,
             max(provider::text) as provider,
             max(cloud_account_id) as cloud_account_id,
             max(service_name) as service_name,
             nullif(max(resource_id), '') as resource_id,
             max(coalesce(tags->>'environment', 'unknown')) as environment,
             consumed_unit,
             max(billing_currency) as currency,
             count(*)::int as metric_count,
             coalesce(sum(consumed_quantity), 0)::float8 as consumed_quantity,
             coalesce(sum(billed_cost), 0)::float8 as total_cost
      from cost_metrics
      where ${Prisma.join(clauses, ' and ')}
      group by date_trunc('month', charge_period_start), ${groupExpression}, consumed_unit
      order by month asc, total_cost desc, consumed_quantity desc
    `;

    return rows.map((row) => {
      const unitCost = row.consumed_quantity > 0 ? row.total_cost / row.consumed_quantity : undefined;

      return {
        month: row.month.toISOString(),
        groupBy,
        groupKey: `${row.group_key} (${row.consumed_unit})`,
        ...(row.provider !== null ? { provider: row.provider } : {}),
        ...(row.cloud_account_id !== null ? { cloudAccountId: row.cloud_account_id } : {}),
        ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
        ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
        ...(row.environment !== null ? { environment: row.environment } : {}),
        consumedQuantity: row.consumed_quantity,
        consumedUnit: row.consumed_unit,
        cost: row.total_cost,
        ...(unitCost !== undefined ? { unitCost } : {}),
        currency: row.currency,
        metricCount: row.metric_count,
      };
    });
  }

  public async findAnomalies(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<CostAnomaly[]> {
    const rows = await this.prisma.costAnomaly.findMany({
      where: {
        tenantId,
        ...(filters.from !== undefined ? { periodStart: { gte: filters.from } } : {}),
        ...(filters.to !== undefined ? { periodStart: { lt: filters.to } } : {}),
        ...(filters.provider !== undefined ? { provider: filters.provider as never } : {}),
        ...(filters.cloudAccountId !== undefined ? { cloudAccountId: filters.cloudAccountId } : {}),
        ...(filters.serviceName !== undefined ? { serviceName: filters.serviceName } : {}),
      },
      orderBy: [
        { severity: 'desc' },
        { detectedAt: 'desc' },
      ],
      take: 100,
    });

    return rows.map((row) => this.toAnomalyDomain(row));
  }

  public async replaceAnomalies(
    tenantId: string,
    anomalies: readonly PersistCostAnomalyInput[],
  ): Promise<CostAnomaly[]> {
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`cost_anomalies:${tenantId}`}))`;
      await tx.costAnomaly.deleteMany({ where: { tenantId } });

      if (anomalies.length > 0) {
        await tx.costAnomaly.createMany({
          data: anomalies.map((item) => ({
          tenantId: item.tenantId,
          ...(item.cloudAccountId !== undefined ? { cloudAccountId: item.cloudAccountId } : {}),
          ...(item.provider !== undefined ? { provider: item.provider as never } : {}),
          ...(item.serviceName !== undefined ? { serviceName: item.serviceName } : {}),
          ...(item.resourceId !== undefined ? { resourceId: item.resourceId } : {}),
          ...(item.environment !== undefined ? { environment: item.environment } : {}),
          periodStart: item.periodStart,
          periodEnd: item.periodEnd,
          baselineCost: item.baselineCost,
          observedCost: item.observedCost,
          deltaAmount: item.deltaAmount,
          deltaPercent: item.deltaPercent,
          ...(item.zScore !== undefined ? { zScore: item.zScore } : {}),
          severity: item.severity,
          status: item.status,
          explanation: item.explanation,
          ...(item.evidence !== undefined ? { evidence: item.evidence as Prisma.InputJsonValue } : {}),
          })),
          skipDuplicates: true,
        });
      }

      return tx.costAnomaly.findMany({
        where: { tenantId },
        orderBy: [
          { severity: 'desc' },
          { detectedAt: 'desc' },
        ],
        take: 100,
      });
    });

    return rows.map((row) => this.toAnomalyDomain(row));
  }

  public async findForecasts(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<CostForecast[]> {
    const rows = await this.prisma.costForecast.findMany({
      where: {
        tenantId,
        ...(filters.provider !== undefined ? { provider: filters.provider as never } : {}),
        ...(filters.cloudAccountId !== undefined ? { cloudAccountId: filters.cloudAccountId } : {}),
        ...(filters.serviceName !== undefined ? { serviceName: filters.serviceName } : {}),
        ...(filters.groupBy !== undefined ? { groupBy: filters.groupBy } : {}),
      },
      orderBy: [
        { forecastMonth: 'asc' },
        { predictedCost: 'desc' },
      ],
      take: 100,
    });

    return rows.map((row) => this.toForecastDomain(row));
  }

  public async replaceForecasts(
    tenantId: string,
    forecasts: readonly PersistCostForecastInput[],
  ): Promise<CostForecast[]> {
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`cost_forecasts:${tenantId}`}))`;
      await tx.costForecast.deleteMany({ where: { tenantId } });

      if (forecasts.length > 0) {
        await tx.costForecast.createMany({
          data: forecasts.map((item) => ({
          tenantId: item.tenantId,
          ...(item.cloudAccountId !== undefined ? { cloudAccountId: item.cloudAccountId } : {}),
          ...(item.provider !== undefined ? { provider: item.provider as never } : {}),
          ...(item.serviceName !== undefined ? { serviceName: item.serviceName } : {}),
          groupBy: item.groupBy,
          groupKey: item.groupKey,
          forecastMonth: item.forecastMonth,
          predictedCost: item.predictedCost,
          lowerBound: item.lowerBound,
          upperBound: item.upperBound,
          method: item.method,
          confidence: item.confidence,
          currency: item.currency,
          ...(item.evidence !== undefined ? { evidence: item.evidence as Prisma.InputJsonValue } : {}),
          })),
          skipDuplicates: true,
        });
      }

      return tx.costForecast.findMany({
        where: { tenantId },
        orderBy: [
          { forecastMonth: 'asc' },
          { predictedCost: 'desc' },
        ],
        take: 100,
      });
    });

    return rows.map((row) => this.toForecastDomain(row));
  }

  private emptySnapshot(tenantId: string): CostAnalyticsSnapshot {
    const now = new Date();

    return {
      tenantId,
      periodStart: now.toISOString(),
      periodEnd: now.toISOString(),
      totalCost: 0,
      currency: 'USD',
      metricCount: 0,
      providers: [],
      accounts: [],
      services: [],
      environments: [],
      topResources: [],
      anomalies: [],
      forecasts: [],
    };
  }

  private groupExpression(groupBy: 'provider' | 'account' | 'service' | 'resource' | 'environment'): Prisma.Sql {
    switch (groupBy) {
      case 'provider':
        return Prisma.sql`provider::text`;
      case 'account':
        return Prisma.sql`cloud_account_id`;
      case 'resource':
        return Prisma.sql`coalesce(nullif(resource_id, ''), 'sin-recurso')`;
      case 'environment':
        return Prisma.sql`coalesce(tags->>'environment', 'unknown')`;
      case 'service':
      default:
        return Prisma.sql`service_name`;
    }
  }

  private toProviderItem(row: ProviderRow): CostAnalyticsProviderItem {
    return {
      provider: row.provider,
      totalCost: row.total_cost,
      metricCount: row.metric_count,
    };
  }

  private toAccountItem(row: AccountRow): CostAnalyticsAccountItem {
    return {
      cloudAccountId: row.cloud_account_id,
      provider: row.provider,
      name: row.name,
      totalCost: row.total_cost,
      metricCount: row.metric_count,
    };
  }

  private toServiceItem(row: ServiceRow): CostAnalyticsServiceItem {
    return {
      serviceName: row.service_name,
      provider: row.provider,
      totalCost: row.total_cost,
      metricCount: row.metric_count,
    };
  }

  private toEnvironmentItem(row: EnvironmentRow): CostAnalyticsEnvironmentItem {
    return {
      environment: row.environment,
      totalCost: row.total_cost,
      metricCount: row.metric_count,
    };
  }

  private toResourceItem(row: ResourceRow): CostAnalyticsResourceItem {
    return {
      resourceId: row.resource_id,
      serviceName: row.service_name,
      provider: row.provider,
      totalCost: row.total_cost,
      metricCount: row.metric_count,
    };
  }

  private toUsageItem(row: TopUsageRow): CostAnalyticsUsageItem {
    const unitCost = row.consumed_quantity > 0 ? row.total_cost / row.consumed_quantity : undefined;

    return {
      serviceName: row.service_name,
      provider: row.provider,
      consumedQuantity: row.consumed_quantity,
      consumedUnit: row.consumed_unit,
      totalCost: row.total_cost,
      ...(unitCost !== undefined ? { unitCost } : {}),
      currency: row.currency,
      metricCount: row.metric_count,
    };
  }

  private toAnomalyDomain(row: Awaited<ReturnType<PrismaClient['costAnomaly']['findFirst']>> & {}): CostAnomaly {
    return {
      id: row.id,
      tenantId: row.tenantId,
      ...(row.cloudAccountId !== null ? { cloudAccountId: row.cloudAccountId } : {}),
      ...(row.provider !== null ? { provider: row.provider } : {}),
      ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
      ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
      ...(row.environment !== null ? { environment: row.environment } : {}),
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      baselineCost: Number(row.baselineCost),
      observedCost: Number(row.observedCost),
      deltaAmount: Number(row.deltaAmount),
      deltaPercent: Number(row.deltaPercent),
      ...(row.zScore !== null ? { zScore: Number(row.zScore) } : {}),
      severity: row.severity,
      status: row.status,
      explanation: row.explanation,
      ...(row.evidence !== null ? { evidence: row.evidence } : {}),
      detectedAt: row.detectedAt.toISOString(),
    };
  }

  private toForecastDomain(row: Awaited<ReturnType<PrismaClient['costForecast']['findFirst']>> & {}): CostForecast {
    return {
      id: row.id,
      tenantId: row.tenantId,
      ...(row.cloudAccountId !== null ? { cloudAccountId: row.cloudAccountId } : {}),
      ...(row.provider !== null ? { provider: row.provider } : {}),
      ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
      groupBy: row.groupBy as CostForecast['groupBy'],
      groupKey: row.groupKey,
      forecastMonth: row.forecastMonth.toISOString(),
      predictedCost: Number(row.predictedCost),
      lowerBound: Number(row.lowerBound),
      upperBound: Number(row.upperBound),
      method: row.method,
      confidence: Number(row.confidence),
      currency: row.currency,
      ...(row.evidence !== null ? { evidence: row.evidence } : {}),
      generatedAt: row.generatedAt.toISOString(),
    };
  }
}
