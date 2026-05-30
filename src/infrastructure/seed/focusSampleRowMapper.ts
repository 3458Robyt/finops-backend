/**
 * Mapeo de filas del dataset de muestra FOCUS: normalización de la fila CSV en
 * crudo a {@link FocusSampleRow}.
 *
 * Reutiliza los helpers primitivos comunes desde
 * `../ingestion/focusFieldParsers.js`. Los helpers con reglas específicas de
 * este dataset (`dateOrNull`, `parseTags`, `parseProvider`) se mantienen aquí
 * porque su semántica difiere de la del parser de OCI y no deben unificarse.
 * La construcción de las filas de inserción de Prisma y el hash de identidad
 * residen en `./focusSampleSeedBuilder.js`.
 */

import { CloudProvider } from '../../generated/prisma/client.js';
import { numberOrNull, stringOrNull } from '../ingestion/focusFieldParsers.js';

/**
 * Fila normalizada del dataset de muestra FOCUS, lista para insertar como
 * métrica de coste de ejemplo.
 *
 * Sigue la especificación FOCUS 1.0: los valores ausentes o `NULL` se mapean a
 * `null`, los importes a `number` y los periodos a `Date` (UTC). Los importes
 * usan la moneda de {@link billingCurrency}.
 */
export interface FocusSampleRow {
  /** Zona de disponibilidad, o `null`. */
  readonly availabilityZone: string | null;
  /** Coste facturado, en la moneda de facturación. Campo obligatorio. */
  readonly billedCost: number;
  /** Identificador de la cuenta de facturación, o `null`. */
  readonly billingAccountId: string | null;
  /** Nombre de la cuenta de facturación, o `null`. */
  readonly billingAccountName: string | null;
  /** Código de moneda de facturación (ISO 4217, p. ej. `USD`). Campo obligatorio. */
  readonly billingCurrency: string;
  /** Fin del periodo de facturación (UTC), o `null`. */
  readonly billingPeriodEnd: Date | null;
  /** Inicio del periodo de facturación (UTC), o `null`. */
  readonly billingPeriodStart: Date | null;
  /** Categoría del cargo; por defecto `Usage` si falta. */
  readonly chargeCategory: string;
  /** Clase del cargo (p. ej. `Correction`), o `null`. */
  readonly chargeClass: string | null;
  /** Descripción del cargo, o `null`. */
  readonly chargeDescription: string | null;
  /** Frecuencia del cargo, o `null`. */
  readonly chargeFrequency: string | null;
  /** Fin del periodo del cargo (UTC). Campo obligatorio. */
  readonly chargePeriodEnd: Date;
  /** Inicio del periodo del cargo (UTC). Campo obligatorio. */
  readonly chargePeriodStart: Date;
  /** Cantidad consumida, o `null`. */
  readonly consumedQuantity: number | null;
  /** Unidad de la cantidad consumida, o `null`. */
  readonly consumedUnit: string | null;
  /** Coste efectivo (amortizado), o `null`. */
  readonly effectiveCost: number | null;
  /** Coste de lista (precio público), o `null`. */
  readonly listCost: number | null;
  /** Cantidad de tarificación, o `null`. */
  readonly pricingQuantity: number | null;
  /** Unidad de tarificación, o `null`. */
  readonly pricingUnit: string | null;
  /** Proveedor cloud normalizado al enum de Prisma {@link CloudProvider}. */
  readonly providerName: CloudProvider;
  /** Identificador de la región, o `null`. */
  readonly regionId: string | null;
  /** Nombre de la región, o `null`. */
  readonly regionName: string | null;
  /** Identificador del recurso. Cadena vacía si no está presente. */
  readonly resourceId: string;
  /** Nombre del recurso, o `null`. */
  readonly resourceName: string | null;
  /** Tipo de recurso, o `null`. */
  readonly resourceType: string | null;
  /** Categoría del servicio, o `null`. */
  readonly serviceCategory: string | null;
  /** Nombre del servicio. Campo obligatorio. */
  readonly serviceName: string;
  /** Identificador de la subcuenta, o `null`. */
  readonly subAccountId: string | null;
  /** Nombre de la subcuenta, o `null`. */
  readonly subAccountName: string | null;
  /** Etiquetas del recurso parseadas desde la columna `Tags` (JSON). Mapa vacío si falta o es inválido. */
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * Fila CSV FOCUS en crudo: cada propiedad corresponde a una columna del dataset
 * de muestra y puede estar ausente (`undefined`). Los valores llegan como string.
 */
export interface RawFocusRow {
  readonly AvailabilityZone?: string;
  readonly BilledCost?: string;
  readonly BillingAccountId?: string;
  readonly BillingAccountName?: string;
  readonly BillingCurrency?: string;
  readonly BillingPeriodEnd?: string;
  readonly BillingPeriodStart?: string;
  readonly ChargeCategory?: string;
  readonly ChargeClass?: string;
  readonly ChargeDescription?: string;
  readonly ChargeFrequency?: string;
  readonly ChargePeriodEnd?: string;
  readonly ChargePeriodStart?: string;
  readonly ConsumedQuantity?: string;
  readonly ConsumedUnit?: string;
  readonly EffectiveCost?: string;
  readonly ListCost?: string;
  readonly PricingQuantity?: string;
  readonly PricingUnit?: string;
  readonly ProviderName?: string;
  readonly RegionId?: string;
  readonly RegionName?: string;
  readonly ResourceId?: string;
  readonly ResourceName?: string;
  readonly ResourceType?: string;
  readonly ServiceCategory?: string;
  readonly ServiceName?: string;
  readonly SubAccountId?: string;
  readonly SubAccountName?: string;
  readonly Tags?: string;
}

/**
 * Normaliza una fila CSV FOCUS en crudo a una {@link FocusSampleRow}, o `null`
 * si no cumple los requisitos mínimos.
 *
 * Una fila se descarta (devuelve `null`) si falta alguno de los campos
 * obligatorios: `BilledCost`, `ChargePeriodStart`, `ChargePeriodEnd`,
 * `ServiceName`, `BillingCurrency` o un proveedor reconocible. Aplica valores
 * por defecto donde corresponde (`chargeCategory` → `Usage`, `resourceId` → `''`).
 *
 * @param row - Fila CSV FOCUS en crudo.
 * @returns La fila normalizada, o `null` si debe descartarse.
 */
export function parseRow(row: RawFocusRow): FocusSampleRow | null {
  const billedCost = numberOrNull(row.BilledCost);
  const chargePeriodStart = dateOrNull(row.ChargePeriodStart);
  const chargePeriodEnd = dateOrNull(row.ChargePeriodEnd);
  const serviceName = stringOrNull(row.ServiceName);
  const billingCurrency = stringOrNull(row.BillingCurrency);
  const provider = parseProvider(row.ProviderName);

  if (
    billedCost === null ||
    chargePeriodStart === null ||
    chargePeriodEnd === null ||
    serviceName === null ||
    billingCurrency === null ||
    provider === null
  ) {
    return null;
  }

  return {
    availabilityZone: stringOrNull(row.AvailabilityZone),
    billedCost,
    billingAccountId: stringOrNull(row.BillingAccountId),
    billingAccountName: stringOrNull(row.BillingAccountName),
    billingCurrency,
    billingPeriodEnd: dateOrNull(row.BillingPeriodEnd),
    billingPeriodStart: dateOrNull(row.BillingPeriodStart),
    chargeCategory: stringOrNull(row.ChargeCategory) ?? 'Usage',
    chargeClass: stringOrNull(row.ChargeClass),
    chargeDescription: stringOrNull(row.ChargeDescription),
    chargeFrequency: stringOrNull(row.ChargeFrequency),
    chargePeriodEnd,
    chargePeriodStart,
    consumedQuantity: numberOrNull(row.ConsumedQuantity),
    consumedUnit: stringOrNull(row.ConsumedUnit),
    effectiveCost: numberOrNull(row.EffectiveCost),
    listCost: numberOrNull(row.ListCost),
    pricingQuantity: numberOrNull(row.PricingQuantity),
    pricingUnit: stringOrNull(row.PricingUnit),
    providerName: provider,
    regionId: stringOrNull(row.RegionId),
    regionName: stringOrNull(row.RegionName),
    resourceId: stringOrNull(row.ResourceId) ?? '',
    resourceName: stringOrNull(row.ResourceName),
    resourceType: stringOrNull(row.ResourceType),
    serviceCategory: stringOrNull(row.ServiceCategory),
    serviceName,
    subAccountId: stringOrNull(row.SubAccountId),
    subAccountName: stringOrNull(row.SubAccountName),
    tags: parseTags(row.Tags),
  };
}

/**
 * Normaliza el nombre del proveedor al enum {@link CloudProvider}.
 *
 * Reconoce (sin distinguir mayúsculas): `AWS`/`AMAZON WEB SERVICES` →
 * {@link CloudProvider.AWS}, y `OCI`/`ORACLE`/`ORACLE CLOUD` →
 * {@link CloudProvider.OCI}. Cualquier otro valor devuelve `null`.
 *
 * @param value - Valor de la columna `ProviderName`, o `undefined`.
 * @returns El proveedor del enum, o `null` si no se reconoce.
 */
function parseProvider(value: string | undefined): CloudProvider | null {
  const normalized = stringOrNull(value)?.toUpperCase();

  if (normalized === 'AWS' || normalized === 'AMAZON WEB SERVICES') {
    return CloudProvider.AWS;
  }

  if (normalized === 'OCI' || normalized === 'ORACLE' || normalized === 'ORACLE CLOUD') {
    return CloudProvider.OCI;
  }

  return null;
}

/**
 * Convierte un string de fecha/hora a un objeto `Date` en UTC, o `null`.
 *
 * Sustituye el primer espacio por `T` y añade el sufijo `Z` para interpretar el
 * valor como UTC (p. ej. `2024-01-01 00:00:00` → `2024-01-01T00:00:00Z`).
 *
 * @param value - Cadena de fecha a convertir, o `undefined`.
 * @returns La fecha parseada, o `null` si está ausente o es inválida.
 */
function dateOrNull(value: string | undefined): Date | null {
  const normalized = stringOrNull(value);

  if (normalized === null) {
    return null;
  }

  const parsed = new Date(`${normalized.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parsea la columna `Tags` (un objeto JSON) a un mapa string→string.
 *
 * Si el valor está ausente, no es JSON válido o no es un objeto (p. ej. array o
 * primitivo), devuelve un mapa vacío. A diferencia de otros parsers, aquí solo
 * se conservan las entradas cuyo valor sea de tipo string; el resto se descartan.
 *
 * @param value - Contenido de la columna `Tags`, o `undefined`.
 * @returns Mapa de etiquetas (solo valores string); vacío si no se puede parsear.
 */
function parseTags(value: string | undefined): Readonly<Record<string, string>> {
  const normalized = stringOrNull(value);

  if (normalized === null) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized);
  } catch {
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const tags: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue === 'string') {
      tags[key] = rawValue;
    }
  }

  return tags;
}

