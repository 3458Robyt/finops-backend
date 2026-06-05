import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import type {
  NormalizedFocusCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { CloudProvider } from '../../generated/prisma/client.js';
import { numberOrNull, stringOrNull } from './focusFieldParsers.js';

interface RawFocusRow {
  readonly [key: string]: string | undefined;
}

export interface ParseFocusCsvInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly provider: CloudProvider;
  readonly focusVersion: string;
  readonly csvText: string;
}

export function decodeMaybeGzip(buffer: Uint8Array, objectName: string): string {
  const bytes = Buffer.from(buffer);
  return objectName.toLowerCase().endsWith('.gz')
    ? gunzipSync(bytes).toString('utf8')
    : bytes.toString('utf8');
}

export function parseFocusCsvToLineItems(input: ParseFocusCsvInput): readonly NormalizedFocusCostLineItem[] {
  const records = parse(input.csvText, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawFocusRow[];

  return records.flatMap((row) => {
    const line = toLineItem(input, row);
    return line === null ? [] : [line];
  });
}

function toLineItem(
  input: ParseFocusCsvInput,
  row: RawFocusRow,
): NormalizedFocusCostLineItem | null {
  const billedCost = numberOrNull(value(row, 'BilledCost'));
  const chargePeriodStart = dateOrNull(value(row, 'ChargePeriodStart'));
  const chargePeriodEnd = dateOrNull(value(row, 'ChargePeriodEnd'));
  const serviceName = stringOrNull(value(row, 'ServiceName'));
  const billingCurrency = stringOrNull(value(row, 'BillingCurrency'));

  if (
    billedCost === null ||
    chargePeriodStart === null ||
    chargePeriodEnd === null ||
    serviceName === null ||
    billingCurrency === null
  ) {
    return null;
  }

  const billingPeriodStart = dateOrNull(value(row, 'BillingPeriodStart'));
  const billingPeriodEnd = dateOrNull(value(row, 'BillingPeriodEnd'));
  const billingAccountId = stringOrNull(value(row, 'BillingAccountId'));
  const subAccountId = stringOrNull(value(row, 'SubAccountId'));
  const resourceId = stringOrNull(value(row, 'ResourceId')) ?? '';
  const regionId = stringOrNull(value(row, 'RegionId')) ?? stringOrNull(value(row, 'Region'));
  const chargeCategory = stringOrNull(value(row, 'ChargeCategory')) ?? 'Usage';
  const effectiveCost = numberOrNull(value(row, 'EffectiveCost'));
  const listCost = numberOrNull(value(row, 'ListCost'));
  const contractedCost = numberOrNull(value(row, 'ContractedCost'));
  const consumedQuantity = numberOrNull(value(row, 'ConsumedQuantity')) ?? numberOrNull(value(row, 'UsageQuantity'));
  const consumedUnit = stringOrNull(value(row, 'ConsumedUnit')) ?? stringOrNull(value(row, 'UsageUnit'));
  const tags = parseTags(value(row, 'Tags'));
  const rawRow = normalizeRawRow(row);

  return {
    tenantId: input.tenantId,
    cloudConnectionId: input.cloudConnectionId,
    provider: input.provider,
    focusVersion: input.focusVersion,
    chargePeriodStart,
    chargePeriodEnd,
    ...(billingPeriodStart !== null ? { billingPeriodStart } : {}),
    ...(billingPeriodEnd !== null ? { billingPeriodEnd } : {}),
    ...(billingAccountId !== null ? { billingAccountId } : {}),
    ...(subAccountId !== null ? { subAccountId } : {}),
    serviceName,
    resourceId,
    ...(regionId !== null ? { regionId } : {}),
    chargeCategory,
    billedCost,
    ...(effectiveCost !== null ? { effectiveCost } : {}),
    ...(listCost !== null ? { listCost } : {}),
    ...(contractedCost !== null ? { contractedCost } : {}),
    billingCurrency,
    ...(consumedQuantity !== null ? { consumedQuantity } : {}),
    ...(consumedUnit !== null ? { consumedUnit } : {}),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    rawRow,
    lineItemHash: buildLineItemHash({
      billingAccountId,
      chargeCategory,
      chargePeriodEnd,
      chargePeriodStart,
      consumedUnit,
      provider: input.provider,
      regionId,
      resourceId,
      serviceName,
      subAccountId,
    }),
  };
}

function buildLineItemHash(identity: Readonly<Record<string, unknown>>): string {
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex');
}

function value(row: RawFocusRow, key: string): string | undefined {
  return row[key];
}

function dateOrNull(raw: string | undefined): Date | null {
  const normalized = stringOrNull(raw);
  if (normalized === null) {
    return null;
  }

  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(hasTimezone ? normalized : `${normalized.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTags(raw: string | undefined): Readonly<Record<string, unknown>> {
  const normalized = stringOrNull(raw);
  if (normalized === null) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeRawRow(row: RawFocusRow): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(row).map(([key, rawValue]) => [key, rawValue ?? '']),
  );
}
