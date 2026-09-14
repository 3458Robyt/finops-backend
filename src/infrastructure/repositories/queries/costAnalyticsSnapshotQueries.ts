import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  AccountRow,
  CurrencyRow,
  EnvironmentRow,
  ProviderRow,
  ResourceRow,
  ServiceRow,
  TopUsageRow,
} from '../mappers/costAnalyticsMappers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas SQL del snapshot analítico de costes
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla las agregaciones `$queryRaw` que componen el snapshot mensual de un
 * tenant, separando el SQL crudo de la orquestación del repositorio. Todas
 * filtran por `tenant_id` (aislamiento multi-tenant) y por el rango mensual
 * `[periodStart, periodEnd)`; los importes se castean a `float8` para devolver
 * `number` en lugar de `Decimal`.
 *
 * @module infrastructure/repositories/queries/costAnalyticsSnapshotQueries
 */

/** Resultado del resumen agregado del periodo (conteo y suma de `billed_cost`). */
export interface SnapshotSummary {
  readonly metricCount: number;
  readonly totalCost: number;
  readonly byCurrency: readonly { readonly currency: string; readonly metricCount: number; readonly totalCost: number }[];
}

/** Conjunto de agregaciones que componen el snapshot mensual de un tenant. */
export interface SnapshotAggregations {
  readonly summary: SnapshotSummary;
  readonly currencies: readonly CurrencyRow[];
  readonly providers: readonly ProviderRow[];
  readonly accounts: readonly AccountRow[];
  readonly services: readonly ServiceRow[];
  readonly environments: readonly EnvironmentRow[];
  readonly topResources: readonly ResourceRow[];
  readonly topUsage: readonly TopUsageRow[];
}

/**
 * Ejecuta en paralelo todas las agregaciones del snapshot mensual de un tenant
 * para el rango `[periodStart, periodEnd)`.
 *
 * Incluye: resumen (conteo y suma de `billed_cost`), divisa predominante, y
 * desgloses por proveedor, cuenta (join con `cloud_accounts`), servicio (top
 * 10), entorno (etiqueta `tags->>'environment'`), recursos (top 10, excluyendo
 * `resource_id` vacío) y uso por servicio/unidad consumida (top 10).
 *
 * @param prisma      Cliente Prisma.
 * @param tenantId    Tenant del que se agregan las métricas (aislamiento multi-tenant).
 * @param periodStart Inicio del mes natural (inclusive, UTC).
 * @param periodEnd   Inicio del mes siguiente (exclusivo, UTC).
 * @returns Conjunto de agregaciones del snapshot.
 */
export async function runSnapshotAggregations(
  prisma: PrismaClient,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<SnapshotAggregations> {
  const [summary, currencies, providers, accounts, services, environments, topResources, topUsage] = await Promise.all([
    prisma.$queryRaw<readonly { readonly currency: string; readonly metric_count: number; readonly total_cost: number }[]>`
      select billing_currency as currency,
             count(*)::int as metric_count,
             coalesce(sum(billed_cost), 0)::float8 as total_cost
      from cost_metrics
      where tenant_id = ${tenantId}
        and charge_period_start >= ${periodStart}
        and charge_period_start < ${periodEnd}
      group by billing_currency
      order by billing_currency asc
    `,
    // Divisa predominante del periodo: la divisa de facturación más frecuente
    // (mayor número de métricas). Se usa como divisa de presentación del
    // snapshot cuando el tenant mezcla varias.
    prisma.$queryRaw<CurrencyRow[]>`
      select billing_currency as currency
      from cost_metrics
      where tenant_id = ${tenantId}
        and charge_period_start >= ${periodStart}
        and charge_period_start < ${periodEnd}
      group by billing_currency
      order by count(*) desc
      limit 1
    `,
    // Coste agregado por proveedor cloud en el mes: cuenta de métricas y suma
    // de billed_cost (en la divisa predominante del tenant). Ordenado de mayor
    // a menor gasto.
    prisma.$queryRaw<ProviderRow[]>`
      select provider::text as provider,
             count(*)::int as metric_count,
             coalesce(sum(billed_cost), 0)::float8 as total_cost,
             billing_currency as currency
      from cost_metrics
      where tenant_id = ${tenantId}
        and charge_period_start >= ${periodStart}
        and charge_period_start < ${periodEnd}
      group by provider, billing_currency
      order by total_cost desc
    `,
    // Coste por cuenta cloud: join con cloud_accounts para resolver el nombre
    // legible de la cuenta. Agrupa por cuenta y proveedor, ordenado por gasto.
    prisma.$queryRaw<AccountRow[]>`
      select cm.cloud_account_id,
             cm.provider::text as provider,
             max(ca.name) as name,
             count(*)::int as metric_count,
             coalesce(sum(cm.billed_cost), 0)::float8 as total_cost,
             cm.billing_currency as currency
      from cost_metrics cm
      inner join cloud_accounts ca on ca.id = cm.cloud_account_id
      where cm.tenant_id = ${tenantId}
        and cm.charge_period_start >= ${periodStart}
        and cm.charge_period_start < ${periodEnd}
      group by cm.cloud_account_id, cm.provider, cm.billing_currency
      order by total_cost desc
    `,
    // Top 10 de servicios por gasto, agrupando por servicio y proveedor.
    prisma.$queryRaw<ServiceRow[]>`
      select service_name,
             provider::text as provider,
             count(*)::int as metric_count,
             coalesce(sum(billed_cost), 0)::float8 as total_cost,
             billing_currency as currency
      from cost_metrics
      where tenant_id = ${tenantId}
        and charge_period_start >= ${periodStart}
        and charge_period_start < ${periodEnd}
      group by service_name, provider, billing_currency
      order by total_cost desc
      limit 10
    `,
    // Coste por entorno: extrae la etiqueta 'environment' del JSON de tags;
    // las métricas sin esa etiqueta se agrupan como 'unknown'.
    prisma.$queryRaw<EnvironmentRow[]>`
      select coalesce(tags->>'environment', 'unknown') as environment,
             count(*)::int as metric_count,
             coalesce(sum(billed_cost), 0)::float8 as total_cost,
             billing_currency as currency
      from cost_metrics
      where tenant_id = ${tenantId}
        and charge_period_start >= ${periodStart}
        and charge_period_start < ${periodEnd}
      group by coalesce(tags->>'environment', 'unknown'), billing_currency
      order by total_cost desc
    `,
    // Top 10 de recursos por gasto. Excluye resource_id vacío (métricas no
    // atribuibles a un recurso concreto). Usa max() para servicio/proveedor
    // representativos del recurso agrupado.
    prisma.$queryRaw<ResourceRow[]>`
      select resource_id,
             max(service_name) as service_name,
             max(provider::text) as provider,
             count(*)::int as metric_count,
             coalesce(sum(billed_cost), 0)::float8 as total_cost,
             billing_currency as currency
      from cost_metrics
      where tenant_id = ${tenantId}
        and charge_period_start >= ${periodStart}
        and charge_period_start < ${periodEnd}
        and resource_id <> ''
      group by resource_id, billing_currency
      order by total_cost desc
      limit 10
    `,
    // Top 10 de uso por servicio y unidad consumida. Solo considera métricas
    // con cantidad y unidad de consumo válidas (no nulas ni vacías), para
    // poder calcular después el coste unitario.
    prisma.$queryRaw<TopUsageRow[]>`
      select service_name,
             provider::text as provider,
             consumed_unit,
           billing_currency as currency,
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
     group by service_name, provider, consumed_unit, billing_currency
      order by total_cost desc, consumed_quantity desc
      limit 10
    `,
  ]);

  return {
    summary: {
      metricCount: summary.reduce((total, row) => total + row.metric_count, 0),
      totalCost: summary.reduce((total, row) => total + row.total_cost, 0),
      byCurrency: summary.map((row) => ({ currency: row.currency, metricCount: row.metric_count, totalCost: row.total_cost })),
    },
    currencies,
    providers,
    accounts,
    services,
    environments,
    topResources,
    topUsage,
  };
}
