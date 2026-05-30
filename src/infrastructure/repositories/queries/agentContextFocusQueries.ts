import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { FocusAggregateRow } from '../mappers/agentContextMappers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas SQL de agregación FOCUS por recurso y periodo
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla la consulta `$queryRaw` de agregación FOCUS del repositorio de contexto
 * del agente IA, separando el SQL crudo de la orquestación y el mapeo a dominio.
 * Recibe el cliente Prisma por parámetro y devuelve las filas crudas
 * ({@link FocusAggregateRow}) para que el repositorio las mapee. Filtra siempre
 * por `tenant_id` (aislamiento multi-tenant) y castea los importes/cantidades a
 * `float8`.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/agentContextFocusQueries
 */

/**
 * Calcula, mediante SQL crudo, las agregaciones FOCUS de coste por recurso y
 * mes natural para un tenant.
 *
 * La consulta agrupa las métricas de coste por recurso (provider, cuenta,
 * servicio, resource_id) y por mes (`date_trunc('month', charge_period_start)`),
 * calculando el inicio y fin del periodo mensual. Detalles:
 * - Filtra por `tenant_id` (aislamiento multi-tenant) y excluye `resource_id`
 *   vacío (solo recursos identificables).
 * - Suma `billed_cost` (casteado a `float8`).
 * - `consumed_quantity`/`consumed_unit`: solo se reportan cuando todas las
 *   métricas del grupo comparten una única unidad de consumo
 *   (`count(distinct consumed_unit) = 1`); si hay unidades mixtas, quedan en
 *   `null` para no sumar magnitudes incompatibles.
 * - `currency`: se toma `max(billing_currency)` como divisa representativa.
 * Ordena por coste facturado descendente.
 *
 * @param prisma   Cliente Prisma.
 * @param tenantId Tenant cuyas agregaciones se calculan.
 * @returns Filas crudas de agregación FOCUS por recurso/periodo.
 */
export function queryFocusResourcePeriodAggregates(
  prisma: PrismaClient,
  tenantId: string,
): Promise<FocusAggregateRow[]> {
  return prisma.$queryRaw<FocusAggregateRow[]>`
    select tenant_id,
           provider::text as provider,
           cloud_account_id,
           service_name,
           resource_id,
           date_trunc('month', charge_period_start) as period_start,
           date_trunc('month', charge_period_start) + interval '1 month' as period_end,
           coalesce(sum(billed_cost), 0)::float8 as billed_cost,
           case when count(distinct consumed_unit) = 1 then coalesce(sum(consumed_quantity), 0)::float8 else null end as consumed_quantity,
           case when count(distinct consumed_unit) = 1 then max(consumed_unit) else null end as consumed_unit,
           max(billing_currency) as currency,
           count(*)::int as metric_count
    from cost_metrics
    where tenant_id = ${tenantId}
      and resource_id <> ''
    group by tenant_id, provider, cloud_account_id, service_name, resource_id, date_trunc('month', charge_period_start)
    order by billed_cost desc
  `;
}
