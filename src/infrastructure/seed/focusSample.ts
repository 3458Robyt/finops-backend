import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type { Prisma } from '../../generated/prisma/client.js';
import { CloudProvider } from '../../generated/prisma/client.js';

export const FOCUS_SAMPLE_URL =
  'https://raw.githubusercontent.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS-Sample-Data/main/FOCUS-1.0/focus_sample_10000.csv';

export interface FocusSampleRow {
  readonly availabilityZone: string | null;
  readonly billedCost: number;
  readonly billingAccountId: string | null;
  readonly billingAccountName: string | null;
  readonly billingCurrency: string;
  readonly billingPeriodEnd: Date | null;
  readonly billingPeriodStart: Date | null;
  readonly chargeCategory: string;
  readonly chargeClass: string | null;
  readonly chargeDescription: string | null;
  readonly chargeFrequency: string | null;
  readonly chargePeriodEnd: Date;
  readonly chargePeriodStart: Date;
  readonly consumedQuantity: number | null;
  readonly consumedUnit: string | null;
  readonly effectiveCost: number | null;
  readonly listCost: number | null;
  readonly pricingQuantity: number | null;
  readonly pricingUnit: string | null;
  readonly providerName: CloudProvider;
  readonly regionId: string | null;
  readonly regionName: string | null;
  readonly resourceId: string;
  readonly resourceName: string | null;
  readonly resourceType: string | null;
  readonly serviceCategory: string | null;
  readonly serviceName: string;
  readonly subAccountId: string | null;
  readonly subAccountName: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

interface RawFocusRow {
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

export async function downloadFocusSampleCsv(
  url = process.env['FOCUS_SAMPLE_CSV_URL'] ?? FOCUS_SAMPLE_URL,
): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download FOCUS sample data: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

export function parseFocusSampleCsv(csv: string): FocusSampleRow[] {
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: false,
  }) as RawFocusRow[];

  return records
    .map(parseRow)
    .filter((row): row is FocusSampleRow => row !== null);
}

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

function parseRow(row: RawFocusRow): FocusSampleRow | null {
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

function stringOrNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '' || trimmed.toUpperCase() === 'NULL') {
    return null;
  }

  return trimmed;
}

function numberOrNull(value: string | undefined): number | null {
  const normalized = stringOrNull(value);

  if (normalized === null) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOrNull(value: string | undefined): Date | null {
  const normalized = stringOrNull(value);

  if (normalized === null) {
    return null;
  }

  const parsed = new Date(`${normalized.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

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
