import type { AnalyticsFilters, AnalyticsGroupBy } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';
import type { MonthlyCostRow, MonthlyUsageRow } from '../mappers/costAnalyticsMappers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas SQL de las series mensuales de costo y consumo
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla las consultas `$queryRaw` de las series mensuales (costo y uso) del
 * repositorio de analítica, junto con la construcción dinámica de cláusulas
 * `where` y la expresión de agrupación. Centralizar aquí el SQL evita
 * duplicarlo entre ambas series y mantiene el repositorio enfocado en mapear
 * filas a dominio. Todas las consultas filtran por `tenant_id` (aislamiento
 * multi-tenant) y castean los importes a `float8`.
 *
 * @module infrastructure/repositories/queries/costAnalyticsSeriesQueries
 */

/**
 * Traduce la dimensión de agrupación lógica (`groupBy`) a la expresión SQL
 * correspondiente, usada en `select`/`group by` de las series mensuales.
 *
 * Casos especiales: `resource` usa `coalesce(nullif(resource_id, ''),
 * 'sin-recurso')` para agrupar las métricas sin recurso bajo una clave estable;
 * `environment` extrae la etiqueta del JSON de tags con fallback `'unknown'`;
 * el valor por defecto agrupa por `service_name`.
 *
 * @param groupBy Dimensión de agrupación solicitada.
 * @returns Fragmento SQL seguro (`Prisma.Sql`) para la agrupación.
 */
export function groupExpression(groupBy: AnalyticsGroupBy): Prisma.Sql {
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

/**
 * Construye las cláusulas `where` comunes (rango temporal semiabierto,
 * proveedor, cuenta y servicio) a partir de los filtros opcionales, partiendo
 * de las cláusulas base proporcionadas (que siempre incluyen `tenant_id`).
 *
 * @param baseClauses Cláusulas iniciales (al menos el filtro de tenant).
 * @param filters Filtros opcionales de rango y dimensiones.
 * @returns Lista completa de cláusulas SQL a unir con `and`.
 */
function buildSeriesClauses(baseClauses: Prisma.Sql[], filters: AnalyticsFilters): Prisma.Sql[] {
  const clauses = [...baseClauses];

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

  return clauses;
}

/**
 * Ejecuta la consulta de la serie mensual de costes, agregando por mes y por la
 * dimensión de agrupación indicada.
 *
 * @param prisma  Cliente Prisma.
 * @param groupBy Dimensión de agrupación (por defecto la resuelve el llamador).
 * @param filters Filtros opcionales de rango y dimensiones.
 * @returns Filas crudas de la serie de costes.
 */
export function queryMonthlyCostRows(
  prisma: PrismaClient,
  tenantId: string,
  groupBy: AnalyticsGroupBy,
  filters: AnalyticsFilters,
): Promise<MonthlyCostRow[]> {
  const expression = groupExpression(groupBy);
  const clauses = buildSeriesClauses([Prisma.sql`tenant_id = ${tenantId}`], filters);

  return prisma.$queryRaw<MonthlyCostRow[]>`
    select date_trunc('month', charge_period_start)::timestamptz as month,
           ${groupBy} as group_by,
           ${expression} as group_key,
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
    group by date_trunc('month', charge_period_start), ${expression}
    order by month asc, total_cost desc
  `;
}

/**
 * Ejecuta la consulta de la serie mensual de uso (consumo), restringida a
 * métricas con cantidad y unidad de consumo válidas, agregando además por
 * `consumed_unit`.
 *
 * @param prisma  Cliente Prisma.
 * @param groupBy Dimensión de agrupación.
 * @param filters Filtros opcionales de rango y dimensiones.
 * @returns Filas crudas de la serie de uso.
 */
export function queryMonthlyUsageRows(
  prisma: PrismaClient,
  tenantId: string,
  groupBy: AnalyticsGroupBy,
  filters: AnalyticsFilters,
): Promise<MonthlyUsageRow[]> {
  const expression = groupExpression(groupBy);
  const clauses = buildSeriesClauses(
    [
      Prisma.sql`tenant_id = ${tenantId}`,
      Prisma.sql`consumed_quantity is not null`,
      Prisma.sql`consumed_unit is not null`,
      Prisma.sql`consumed_unit <> ''`,
    ],
    filters,
  );

  return prisma.$queryRaw<MonthlyUsageRow[]>`
    select date_trunc('month', charge_period_start)::timestamptz as month,
           ${groupBy} as group_by,
           ${expression} as group_key,
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
    group by date_trunc('month', charge_period_start), ${expression}, consumed_unit
    order by month asc, total_cost desc, consumed_quantity desc
  `;
}
