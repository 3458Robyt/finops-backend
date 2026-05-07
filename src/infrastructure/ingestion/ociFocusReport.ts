import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';

export interface OciFocusReportRow {
  readonly availabilityZone: string | null;
  readonly billedCost: number;
  readonly billingAccountId: string | null;
  readonly billingAccountName: string | null;
  readonly billingCurrency: string;
  readonly billingPeriodEnd: Date | null;
  readonly billingPeriodStart: Date | null;
  readonly chargeCategory: string;
  readonly chargeDescription: string | null;
  readonly chargeFrequency: string | null;
  readonly chargePeriodEnd: Date;
  readonly chargePeriodStart: Date;
  readonly chargeSubcategory: string | null;
  readonly contractedCost: number | null;
  readonly effectiveCost: number | null;
  readonly listCost: number | null;
  readonly pricingQuantity: number | null;
  readonly pricingUnit: string | null;
  readonly provider: 'OCI';
  readonly regionId: string | null;
  readonly resourceId: string;
  readonly resourceName: string | null;
  readonly resourceType: string | null;
  readonly serviceCategory: string | null;
  readonly serviceName: string;
  readonly subAccountId: string | null;
  readonly subAccountName: string | null;
  readonly tags: Record<string, string>;
  readonly usageQuantity: number | null;
  readonly usageUnit: string | null;
  readonly oci: Record<string, string>;
  readonly rawRow: Record<string, string>;
}

export interface ParseOciFocusCsvResult {
  readonly columns: readonly string[];
  readonly rawRowCount: number;
  readonly rows: readonly OciFocusReportRow[];
  readonly skippedRowCount: number;
}

interface RawCsvRow {
  readonly [key: string]: string | undefined;
}

const requiredColumns = [
  'BilledCost',
  'BillingCurrency',
  'ChargePeriodEnd',
  'ChargePeriodStart',
  'Provider',
  'ServiceName',
] as const;

export async function parseOciFocusReportFile(filePath: string): Promise<ParseOciFocusCsvResult> {
  const buffer = await readFile(filePath);
  const text = filePath.toLowerCase().endsWith('.gz')
    ? gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8');

  return parseOciFocusCsvText(text);
}

export function parseOciFocusCsvText(csvText: string): ParseOciFocusCsvResult {
  const records = parse(csvText, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawCsvRow[];

  const columns = inferColumns(csvText, records);
  assertRequiredColumns(columns);

  const rows: OciFocusReportRow[] = [];

  for (const raw of records) {
    const row = toOciFocusRow(raw);

    if (row !== null) {
      rows.push(row);
    }
  }

  return {
    columns,
    rawRowCount: records.length,
    rows,
    skippedRowCount: records.length - rows.length,
  };
}

export function buildOciFocusLineHash(row: OciFocusReportRow): string {
  return sha256Json({
    billingAccountId: row.billingAccountId,
    billedCost: row.billedCost,
    chargeCategory: row.chargeCategory,
    chargeDescription: row.chargeDescription,
    chargePeriodEnd: row.chargePeriodEnd.toISOString(),
    chargePeriodStart: row.chargePeriodStart.toISOString(),
    effectiveCost: row.effectiveCost,
    ociBackReferenceNumber: row.oci['oci_BackReferenceNumber'] ?? null,
    ociReferenceNumber: row.oci['oci_ReferenceNumber'] ?? null,
    provider: row.provider,
    regionId: row.regionId,
    resourceId: row.resourceId,
    serviceName: row.serviceName,
    subAccountId: row.subAccountId,
    usageQuantity: row.usageQuantity,
    usageUnit: row.usageUnit,
  });
}

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

function toOciFocusRow(raw: RawCsvRow): OciFocusReportRow | null {
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

function inferColumns(csvText: string, records: readonly RawCsvRow[]): readonly string[] {
  const firstRecord = records[0];

  if (firstRecord !== undefined) {
    return Object.keys(firstRecord);
  }

  const firstLine = csvText.split(/\r?\n/, 1)[0];
  return firstLine === undefined || firstLine.trim() === ''
    ? []
    : firstLine.split(',').map((column) => column.trim().replace(/^\uFEFF/, ''));
}

function assertRequiredColumns(columns: readonly string[]): void {
  const columnSet = new Set(columns);
  const missing = requiredColumns.filter((column) => !columnSet.has(column));

  if (missing.length > 0) {
    throw new Error(`OCI FOCUS report is missing required columns: ${missing.join(', ')}`);
  }
}

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

function value(row: RawCsvRow, key: string): string | null {
  return stringOrNull(row[key] ?? null);
}

function stringOrNull(input: string | null): string | null {
  if (input === null) {
    return null;
  }

  const trimmed = input.trim();

  if (trimmed === '' || trimmed.toUpperCase() === 'NULL') {
    return null;
  }

  return trimmed;
}

function numberOrNull(input: string | null): number | null {
  const normalized = stringOrNull(input);

  if (normalized === null) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function extractOciFields(row: RawCsvRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key, rowValue]) => key.startsWith('oci_') && stringOrNull(rowValue ?? null) !== null)
      .map(([key, rowValue]) => [key, stringOrNull(rowValue ?? null) ?? '']),
  );
}

function normalizeRawRow(row: RawCsvRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).map(([key, rowValue]) => [key, rowValue ?? '']),
  );
}

function sha256Json(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
}
