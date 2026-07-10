/**
 * Construcción de las filas de inserción masiva de Prisma a partir de filas
 * FOCUS normalizadas, junto con el cálculo del hash de identidad de cada métrica.
 *
 * Responsabilidad: traducir una {@link FocusSampleRow} (modelo normalizado) al
 * input `CostMetricCreateManyInput` de Prisma y garantizar la unicidad de cada
 * métrica de muestra mediante un hash SHA-256 estable. Se separa de
 * `./focusSampleRowMapper.js` (que normaliza la fila CSV cruda) para mantener
 * cada módulo enfocado en una sola responsabilidad.
 */

import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { FocusSampleRow } from './focusSampleRowMapper.js';

/**
 * Construye las filas de inserción masiva (`createMany`) de métricas de coste
 * de Prisma a partir de las filas FOCUS normalizadas.
 *
 * Mapea cada {@link FocusSampleRow} al modelo `CostMetric`, asociándola al
 * tenant y la cuenta cloud indicados. Genera un `metricIdentityHash` único por
 * fila (vía {@link buildMetricIdentityHash}), fija `sourceMetric` a
 * `FOCUSSampleBilledCost`, reutiliza la moneda de facturación como moneda de
 * tarificación (`pricingCurrency`) y registra la procedencia en `providerRaw`.
 *
 * @param input - Filas FOCUS de origen junto con el `tenantId` y `cloudAccountId`
 *   de destino.
 * @returns Lista de objetos `CostMetricCreateManyInput` listos para insertar.
 */
export function buildCostMetricSeedRows(input: {
  readonly rows: readonly FocusSampleRow[];
  readonly tenantId: string;
  readonly cloudAccountId: string;
}): Prisma.CostMetricCreateManyInput[] {
  return input.rows.map((row, index) => ({
    tenantId: input.tenantId,
    cloudAccountId: input.cloudAccountId,
    provider: row.providerName,
    billingAccountId: row.billingAccountId,
    billingAccountName: row.billingAccountName,
    subAccountId: row.subAccountId,
    subAccountName: row.subAccountName,
    serviceName: row.serviceName,
    serviceCategory: row.serviceCategory,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    resourceType: row.resourceType,
    regionId: row.regionId,
    regionName: row.regionName,
    availabilityZone: row.availabilityZone,
    chargeCategory: row.chargeCategory,
    chargeClass: row.chargeClass,
    chargeFrequency: row.chargeFrequency,
    chargePeriodStart: row.chargePeriodStart,
    chargePeriodEnd: row.chargePeriodEnd,
    billingPeriodStart: row.billingPeriodStart,
    billingPeriodEnd: row.billingPeriodEnd,
    billedCost: row.billedCost,
    effectiveCost: row.effectiveCost,
    listCost: row.listCost,
    billingCurrency: row.billingCurrency,
    pricingCurrency: row.billingCurrency,
    consumedQuantity: row.consumedQuantity,
    consumedUnit: row.consumedUnit,
    pricingQuantity: row.pricingQuantity,
    pricingUnit: row.pricingUnit,
    sourceMetric: 'FOCUSSampleBilledCost',
    metricIdentityHash: buildMetricIdentityHash(input.tenantId, input.cloudAccountId, row, index),
    tags: row.tags,
    providerRaw: {
      source: 'FinOps-Open-Cost-and-Usage-Spec/FOCUS-Sample-Data',
    },
  }));
}

/**
 * Calcula un hash SHA-256 estable que identifica de forma única una métrica de
 * coste de muestra dentro de un tenant y cuenta cloud.
 *
 * Combina `tenantId`, `cloudAccountId`, el índice de la fila y los campos más
 * discriminantes (periodos en ISO, servicio, recurso, categoría, descripción,
 * región, subcuenta y coste facturado), serializándolos como array JSON antes
 * de aplicar SHA-256. El `index` evita colisiones entre filas por lo demás
 * idénticas del dataset de muestra.
 *
 * @param tenantId - Identificador del tenant de destino.
 * @param cloudAccountId - Identificador de la cuenta cloud de destino.
 * @param row - Fila FOCUS normalizada.
 * @param index - Posición de la fila dentro del lote, para garantizar unicidad.
 * @returns Hash SHA-256 en hexadecimal de la identidad de la métrica.
 */
function buildMetricIdentityHash(
  tenantId: string,
  cloudAccountId: string,
  row: FocusSampleRow,
  index: number,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      tenantId,
      cloudAccountId,
      index,
      row.chargePeriodStart.toISOString(),
      row.chargePeriodEnd.toISOString(),
      row.serviceName,
      row.resourceId,
      row.chargeCategory,
      row.chargeDescription,
      row.regionId,
      row.subAccountId,
      row.billedCost,
    ]))
    .digest('hex');
}
