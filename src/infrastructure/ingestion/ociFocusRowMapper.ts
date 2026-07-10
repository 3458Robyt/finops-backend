/**
 * Mapeo de filas de reportes FOCUS de OCI: normalización de la fila CSV en
 * crudo a {@link OciFocusReportRow}, junto con los helpers de parseo específicos
 * de OCI.
 *
 * Reutiliza los helpers primitivos comunes desde `./focusFieldParsers.js`. Las
 * funciones con reglas propias de OCI (`dateOrNull`, `parseTags`,
 * `parseProvider`, extracción de columnas `oci_*`) se mantienen aquí porque su
 * semántica difiere de la del parser del dataset de muestra y no deben unificarse.
 */

import { numberOrNull, stringOrNull } from './focusFieldParsers.js';

/**
 * Fila normalizada de un reporte FOCUS de OCI (Oracle Cloud Infrastructure).
 *
 * Cada propiedad se deriva de una columna del CSV FOCUS y se normaliza:
 * los valores ausentes o `NULL` se convierten a `null`, los importes a `number`
 * y los periodos a objetos `Date` (UTC). Los campos sin sufijo de unidad usan
 * la moneda indicada en {@link billingCurrency}.
 */
export interface OciFocusReportRow {
  /** Zona de disponibilidad del recurso, o `null` si no aplica. */
  readonly availabilityZone: string | null;
  /** Coste facturado para la línea, en la moneda de facturación. Campo obligatorio. */
  readonly billedCost: number;
  /** Identificador de la cuenta de facturación, o `null`. */
  readonly billingAccountId: string | null;
  /** Nombre de la cuenta de facturación, o `null`. */
  readonly billingAccountName: string | null;
  /** Código de moneda de facturación (ISO 4217, p. ej. `USD`). Campo obligatorio. */
  readonly billingCurrency: string;
  /** Fin del periodo de facturación (UTC), o `null` si no está presente o es inválido. */
  readonly billingPeriodEnd: Date | null;
  /** Inicio del periodo de facturación (UTC), o `null` si no está presente o es inválido. */
  readonly billingPeriodStart: Date | null;
  /** Categoría del cargo (p. ej. `Usage`); por defecto `Usage` si falta. */
  readonly chargeCategory: string;
  /** Descripción del cargo, o `null`. */
  readonly chargeDescription: string | null;
  /** Frecuencia del cargo (p. ej. `Recurring`, `Usage-Based`), o `null`. */
  readonly chargeFrequency: string | null;
  /** Fin del periodo del cargo (UTC). Campo obligatorio. */
  readonly chargePeriodEnd: Date;
  /** Inicio del periodo del cargo (UTC). Campo obligatorio. */
  readonly chargePeriodStart: Date;
  /** Subcategoría del cargo, o `null`. */
  readonly chargeSubcategory: string | null;
  /** Coste contratado, o `null`. */
  readonly contractedCost: number | null;
  /** Coste efectivo (amortizado), o `null`. */
  readonly effectiveCost: number | null;
  /** Coste de lista (precio público), o `null`. */
  readonly listCost: number | null;
  /** Cantidad de tarificación (*pricing*), o `null`. */
  readonly pricingQuantity: number | null;
  /** Unidad de tarificación, o `null`. */
  readonly pricingUnit: string | null;
  /** Proveedor cloud. Siempre `'OCI'` en este parser. */
  readonly provider: 'OCI';
  /** Identificador de la región (columna `Region`), o `null`. */
  readonly regionId: string | null;
  /** Identificador del recurso (OCID). Cadena vacía si no está presente. */
  readonly resourceId: string;
  /** Nombre del recurso, o `null`. */
  readonly resourceName: string | null;
  /** Tipo de recurso, o `null`. */
  readonly resourceType: string | null;
  /** Categoría del servicio, o `null`. */
  readonly serviceCategory: string | null;
  /** Nombre del servicio. Campo obligatorio. */
  readonly serviceName: string;
  /** Identificador de la subcuenta (compartment), o `null`. */
  readonly subAccountId: string | null;
  /** Nombre de la subcuenta, o `null`. */
  readonly subAccountName: string | null;
  /** Etiquetas del recurso parseadas desde la columna `Tags` (JSON). Mapa vacío si falta o es inválido. */
  readonly tags: Record<string, string>;
  /** Cantidad de uso, o `null`. */
  readonly usageQuantity: number | null;
  /** Unidad de uso, o `null`. */
  readonly usageUnit: string | null;
  /** Columnas específicas de OCI (prefijo `oci_`) con valor no nulo. */
  readonly oci: Record<string, string>;
  /** Fila CSV original completa, con todos los valores como string (vacío si faltaba). */
  readonly rawRow: Record<string, string>;
}

/** Fila CSV en crudo: mapa de nombre de columna a su valor (o `undefined`). */
export interface RawCsvRow {
  readonly [key: string]: string | undefined;
}

/**
 * Convierte una fila CSV en crudo a una {@link OciFocusReportRow} normalizada,
 * o `null` si no cumple los requisitos mínimos.
 *
 * Una fila se descarta (devuelve `null`) si el proveedor no es OCI o si falta
 * alguno de los campos obligatorios: `BilledCost`, `ChargePeriodStart`,
 * `ChargePeriodEnd`, `ServiceName` o `BillingCurrency`. Aplica valores por
 * defecto donde corresponde (`chargeCategory` → `Usage`, `resourceId` → `''`).
 *
 * @param raw - Fila CSV en crudo (valores como string u `undefined`).
 * @returns La fila normalizada, o `null` si debe descartarse.
 */
export function toOciFocusRow(raw: RawCsvRow): OciFocusReportRow | null {
  const provider = parseProvider(value(raw, 'Provider'));
  const billedCost = numberOrNull(value(raw, 'BilledCost'));
  const chargePeriodStart = dateOrNull(value(raw, 'ChargePeriodStart'));
  const chargePeriodEnd = dateOrNull(value(raw, 'ChargePeriodEnd'));
  const serviceName = stringOrNull(value(raw, 'ServiceName'));
  const billingCurrency = stringOrNull(value(raw, 'BillingCurrency'));

  if (
    provider !== 'OCI' ||
    billedCost === null ||
    chargePeriodStart === null ||
    chargePeriodEnd === null ||
    serviceName === null ||
    billingCurrency === null
  ) {
    return null;
  }

  return {
    availabilityZone: stringOrNull(value(raw, 'AvailabilityZone')),
    billedCost,
    billingAccountId: stringOrNull(value(raw, 'BillingAccountId')),
    billingAccountName: stringOrNull(value(raw, 'BillingAccountName')),
    billingCurrency,
    billingPeriodEnd: dateOrNull(value(raw, 'BillingPeriodEnd')),
    billingPeriodStart: dateOrNull(value(raw, 'BillingPeriodStart')),
    chargeCategory: stringOrNull(value(raw, 'ChargeCategory')) ?? 'Usage',
    chargeDescription: stringOrNull(value(raw, 'ChargeDescription')),
    chargeFrequency: stringOrNull(value(raw, 'ChargeFrequency')),
    chargePeriodEnd,
    chargePeriodStart,
    chargeSubcategory: stringOrNull(value(raw, 'ChargeSubcategory')),
    contractedCost: numberOrNull(value(raw, 'ContractedCost')),
    effectiveCost: numberOrNull(value(raw, 'EffectiveCost')),
    listCost: numberOrNull(value(raw, 'ListCost')),
    pricingQuantity: numberOrNull(value(raw, 'PricingQuantity')),
    pricingUnit: stringOrNull(value(raw, 'PricingUnit')),
    provider,
    regionId: stringOrNull(value(raw, 'Region')),
    resourceId: stringOrNull(value(raw, 'ResourceId')) ?? '',
    resourceName: stringOrNull(value(raw, 'ResourceName')),
    resourceType: stringOrNull(value(raw, 'ResourceType')),
    serviceCategory: stringOrNull(value(raw, 'ServiceCategory')),
    serviceName,
    subAccountId: stringOrNull(value(raw, 'SubAccountId')),
    subAccountName: stringOrNull(value(raw, 'SubAccountName')),
    tags: parseTags(value(raw, 'Tags')),
    usageQuantity: numberOrNull(value(raw, 'UsageQuantity')),
    usageUnit: stringOrNull(value(raw, 'UsageUnit')),
    oci: extractOciFields(raw),
    rawRow: normalizeRawRow(raw),
  };
}

/**
 * Normaliza el nombre del proveedor a `'OCI'` o `null`.
 *
 * Acepta varias formas equivalentes (sin distinguir mayúsculas): `OCI`,
 * `ORACLE`, `ORACLE CLOUD` y `ORACLE CLOUD INFRASTRUCTURE`. Cualquier otro
 * valor (o `null`) devuelve `null`, lo que provoca el descarte de la fila.
 *
 * @param input - Valor de la columna `Provider`, ya normalizado a string o `null`.
 * @returns `'OCI'` si coincide con una variante reconocida; `null` en caso contrario.
 */
function parseProvider(input: string | null): 'OCI' | null {
  if (input === null) {
    return null;
  }

  const normalized = input.toUpperCase();

  if (
    normalized === 'OCI' ||
    normalized === 'ORACLE' ||
    normalized === 'ORACLE CLOUD' ||
    normalized === 'ORACLE CLOUD INFRASTRUCTURE'
  ) {
    return 'OCI';
  }

  return null;
}

/**
 * Obtiene y normaliza el valor de una columna de la fila CSV.
 *
 * @param row - Fila CSV en crudo.
 * @param key - Nombre de la columna a leer.
 * @returns El valor saneado (vía {@link stringOrNull}), o `null` si está ausente/vacío.
 */
function value(row: RawCsvRow, key: string): string | null {
  return stringOrNull(row[key] ?? null);
}

/**
 * Convierte un string de fecha/hora a un objeto `Date` en UTC, o `null`.
 *
 * Normaliza distintos formatos hacia ISO 8601:
 * - Si no contiene `T`, sustituye el primer espacio por `T` (p. ej.
 *   `2024-01-01 00:00:00` → `2024-01-01T00:00:00`).
 * - Si no incluye zona horaria (`Z` o `±HH:MM`), añade `Z` para interpretarlo
 *   como UTC.
 *
 * @param input - Cadena de fecha a convertir, o `null`.
 * @returns La fecha parseada, o `null` si está ausente o es inválida.
 */
function dateOrNull(input: string | null): Date | null {
  const normalized = stringOrNull(input);

  if (normalized === null) {
    return null;
  }

  const isoLike = normalized.includes('T') ? normalized : normalized.replace(' ', 'T');
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(isoLike) ? isoLike : `${isoLike}Z`;
  const parsed = new Date(withTimezone);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parsea la columna `Tags` (un objeto JSON) a un mapa string→string.
 *
 * Si el valor está ausente, no es JSON válido, o no es un objeto (p. ej. array
 * o primitivo), devuelve un mapa vacío. Los valores no string se serializan con
 * `JSON.stringify` para garantizar que el mapa sea siempre string→string.
 *
 * @param input - Contenido de la columna `Tags`, o `null`.
 * @returns Mapa de etiquetas; vacío si no se puede parsear.
 */
function parseTags(input: string | null): Record<string, string> {
  const normalized = stringOrNull(input);

  if (normalized === null) {
    return {};
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * Extrae las columnas específicas de OCI (las que empiezan por `oci_`) con
 * valor no nulo.
 *
 * @param row - Fila CSV en crudo.
 * @returns Mapa con las columnas `oci_*` y sus valores saneados.
 */
function extractOciFields(row: RawCsvRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key, rowValue]) => key.startsWith('oci_') && stringOrNull(rowValue ?? null) !== null)
      .map(([key, rowValue]) => [key, stringOrNull(rowValue ?? null) ?? '']),
  );
}

/**
 * Devuelve la fila CSV original con todos los valores como string, sustituyendo
 * los `undefined` por cadena vacía (preserva el dato crudo sin sanear).
 *
 * @param row - Fila CSV en crudo.
 * @returns Mapa con todas las columnas y sus valores originales como string.
 */
function normalizeRawRow(row: RawCsvRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).map(([key, rowValue]) => [key, rowValue ?? '']),
  );
}
