import type {
  ValueRealizationFilters,
  ValueRealizationItem,
} from '../../domain/interfaces/IValueRealizationRepository.js';

export const defaultPageSize = 50;
export const maxPageSize = 100;
export const maxExportPageSize = 10_000;

export type ValueRealizationRow = Record<string, unknown>;

export interface ValueRealizationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function toItem(row: ValueRealizationRow): ValueRealizationItem {
  const estimated = numberValue(row['estimated_monthly_savings']);
  const verified = numberValue(row['verified_monthly_savings']);
  const manualExecutionId = stringValue(row['manual_execution_id']);
  const measurementId = stringValue(row['measurement_id']);
  const serviceName = stringValue(row['service_name']);
  const resourceId = stringValue(row['resource_id']);
  const confidenceLevel = stringValue(row['confidence_level']);
  const billingSource = stringValue(row['billing_source']);
  const costBasis = stringValue(row['cost_basis']);
  const executedAt = dateValue(row['executed_at']);
  const observationEnd = dateValue(row['observation_end']);
  const verifiedAt = dateValue(row['verified_at']);
  const measurementStatus = stringValue(row['measurement_status']) as ValueRealizationItem['measurementStatus'] | undefined;
  return {
    recommendationId: stringValue(row['recommendation_id']) ?? '',
    ...(manualExecutionId !== undefined ? { manualExecutionId } : {}),
    ...(measurementId !== undefined ? { measurementId } : {}),
    title: stringValue(row['title']) ?? '',
    description: stringValue(row['description']) ?? '',
    recommendationStatus: stringValue(row['recommendation_status']) ?? 'PENDING',
    severity: stringValue(row['severity']) ?? 'MEDIUM',
    type: stringValue(row['type']) ?? '',
    cloudAccountId: stringValue(row['cloud_account_id']) ?? '',
    cloudAccountName: stringValue(row['cloud_account_name']) ?? '',
    provider: stringValue(row['provider']) ?? '',
    ...(serviceName !== undefined ? { serviceName } : {}),
    ...(resourceId !== undefined ? { resourceId } : {}),
    currency: stringValue(row['currency']) ?? 'USD',
    estimatedMonthlySavings: estimated,
    reportedMonthlySavings: numberValue(row['reported_monthly_savings']),
    ...(row['observed_savings'] !== null && row['observed_savings'] !== undefined ? { observedSavings: numberValue(row['observed_savings']) } : {}),
    ...(row['projected_monthly_savings'] !== null && row['projected_monthly_savings'] !== undefined ? { projectedMonthlySavings: numberValue(row['projected_monthly_savings']) } : {}),
    verifiedMonthlySavings: verified,
    costIncreaseMonthlyAmount: numberValue(row['cost_increase_monthly_amount']),
    varianceAgainstEstimate: verified - estimated,
    ...(row['coverage_ratio'] !== null && row['coverage_ratio'] !== undefined ? { coverageRatio: numberValue(row['coverage_ratio']) } : {}),
    ...(confidenceLevel !== undefined ? { confidenceLevel } : {}),
    ...(billingSource !== undefined ? { billingSource } : {}),
    ...(costBasis !== undefined ? { costBasis } : {}),
    ...(measurementStatus !== undefined ? { measurementStatus } : { measurementStatus: 'NO_EXECUTION' }),
    ...(executedAt !== undefined ? { executedAt } : {}),
    ...(observationEnd !== undefined ? { observationEnd } : {}),
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    nextAction: (stringValue(row['next_action']) ?? 'NONE') as ValueRealizationItem['nextAction'],
    createdAt: dateValue(row['created_at']) ?? new Date(0),
    updatedAt: dateValue(row['updated_at']) ?? new Date(0),
  };
}

export function encodeCursor(row: ValueRealizationRow): string {
  const value = JSON.stringify({
    createdAt: (dateValue(row['created_at']) ?? new Date(0)).toISOString(),
    id: stringValue(row['recommendation_id']) ?? '',
  });
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(value: string | undefined): ValueRealizationCursor | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    const createdAt = dateValue(parsed.createdAt);
    if (createdAt === undefined || typeof parsed.id !== 'string' || parsed.id === '') throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new Error('El cursor de valor realizado no es válido');
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function intValue(value: unknown): number {
  return Math.trunc(numberValue(value));
}

export function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

export function monthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

export type ValueRealizationFilterInput = ValueRealizationFilters;
