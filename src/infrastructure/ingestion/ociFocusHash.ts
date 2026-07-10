/**
 * Hashing de identidad para líneas y métricas de coste de reportes FOCUS de OCI.
 *
 * Expone el cálculo del hash natural de una línea y del hash de identidad de
 * métrica (línea + tenant + cuenta cloud), ambos estables y deterministas para
 * deduplicar ingestas.
 */

import { createHash } from 'node:crypto';
import type { OciFocusReportRow } from './ociFocusRowMapper.js';

/**
 * Calcula un hash SHA-256 estable que identifica de forma única una línea del
 * reporte FOCUS de OCI.
 *
 * Combina solo los campos inmutables que identifican la línea (cuenta, cargo,
 * periodos, recurso, servicio, región, unidad de uso y los números de referencia
 * propios de OCI) y los serializa a JSON antes de aplicar SHA-256. Sirve para
 * deduplicar líneas en ingestas.
 *
 * No incluye medidas mutables (costes ni cantidad de uso): una corrección de
 * monto debe actualizar la línea existente, no generar un hash distinto que la
 * duplique.
 *
 * @param row - Fila normalizada del reporte FOCUS de OCI.
 * @returns Hash SHA-256 en hexadecimal de la identidad de la línea.
 */
export function buildOciFocusLineHash(row: OciFocusReportRow): string {
  return sha256Json({
    billingAccountId: row.billingAccountId,
    chargeCategory: row.chargeCategory,
    chargeDescription: row.chargeDescription,
    chargePeriodEnd: row.chargePeriodEnd.toISOString(),
    chargePeriodStart: row.chargePeriodStart.toISOString(),
    ociBackReferenceNumber: row.oci['oci_BackReferenceNumber'] ?? null,
    ociReferenceNumber: row.oci['oci_ReferenceNumber'] ?? null,
    provider: row.provider,
    regionId: row.regionId,
    resourceId: row.resourceId,
    serviceName: row.serviceName,
    subAccountId: row.subAccountId,
    usageUnit: row.usageUnit,
  });
}

/**
 * Calcula el hash de identidad de una métrica de coste de OCI dentro de un
 * tenant y cuenta cloud concretos.
 *
 * Combina `tenantId`, `cloudAccountId` y el hash de la línea
 * ({@link buildOciFocusLineHash}) para obtener un identificador único por
 * métrica, evitando colisiones entre tenants o cuentas distintas.
 *
 * @param input - Datos de contexto: tenant, cuenta cloud y hash de la línea.
 * @returns Hash SHA-256 en hexadecimal de la identidad de la métrica.
 */
export function buildOciCostMetricIdentityHash(input: {
  readonly tenantId: string;
  readonly cloudAccountId: string;
  readonly lineItemHash: string;
}): string {
  return sha256Json({
    cloudAccountId: input.cloudAccountId,
    lineItemHash: input.lineItemHash,
    tenantId: input.tenantId,
  });
}

/**
 * Calcula el hash SHA-256 (hexadecimal) de la representación JSON de un valor.
 *
 * @param input - Valor a serializar y hashear.
 * @returns Hash SHA-256 en hexadecimal.
 */
function sha256Json(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}
