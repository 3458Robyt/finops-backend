import type { CloudCapabilityValidation } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { CloudConnectionSummary } from '../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export interface TechnicalBackfillWindow {
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly interval?: '1m' | '5m' | '30m' | '1h';
}

export function buildBackfillWindows(
  rangeStart: Date,
  rangeEnd: Date,
  windowHours: number,
): readonly TechnicalBackfillWindow[] {
  const windows: TechnicalBackfillWindow[] = [];
  const windowMs = windowHours * 60 * 60 * 1000;
  let cursor = new Date(rangeStart);

  while (cursor.getTime() < rangeEnd.getTime()) {
    const targetStart = new Date(cursor);
    const targetEnd = new Date(Math.min(cursor.getTime() + windowMs, rangeEnd.getTime()));
    windows.push({ targetStart, targetEnd });
    cursor = targetEnd;
  }

  return windows;
}

export function currentMinute(): Date {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000);
}

/**
 * Uses the provider's 30-minute sample boundary so repeated backfills reuse
 * the same windows instead of drifting by the minute and creating duplicates.
 */
export function currentMetricBoundary(): Date {
  const boundaryMs = 30 * 60 * 1000;
  return new Date(Math.floor(Date.now() / boundaryMs) * boundaryMs);
}

export function serializeCapabilityValidation(
  validation: CloudCapabilityValidation,
): Readonly<Record<string, unknown>> {
  return {
    capability: validation.capability,
    status: validation.status,
    message: validation.message,
    checkedAt: validation.checkedAt.toISOString(),
    ...(validation.metadata !== undefined ? { metadata: validation.metadata } : {}),
  };
}

export function hasUsableValidation(connection: CloudConnectionSummary): boolean {
  if (connection.lastValidatedAt === undefined) return false;
  const validation = connection.metadata?.['capabilityValidation'];
  if (!isRecord(validation) || !Array.isArray(validation['capabilities'])) return false;
  const available = validation['capabilities'].filter((item): item is Readonly<Record<string, unknown>> =>
    isRecord(item) && item['status'] === 'AVAILABLE',
  );
  const authentication = validation['authentication'];
  const authenticated = isRecord(authentication)
    ? authentication['status'] === 'VERIFIED'
    : available.some((item) => item['capability'] === 'IDENTITY');
  return authenticated
    && available.some((item) => ['INVENTORY', 'COSTS', 'METRICS', 'STORAGE'].includes(String(item['capability'])));
}

export function availableCapabilities(connection: CloudConnectionSummary): ReadonlySet<string> {
  const validation = connection.metadata?.['capabilityValidation'];
  if (!isRecord(validation) || !Array.isArray(validation['capabilities'])) return new Set();
  return new Set(validation['capabilities']
    .filter((item): item is Readonly<Record<string, unknown>> => isRecord(item) && item['status'] === 'AVAILABLE')
    .map((item) => String(item['capability'])));
}

export function hasUsableBillingSource(
  connection: CloudConnectionSummary,
  capabilities: ReadonlySet<string>,
): boolean {
  const mode = connection.metadata?.['billingSourceMode'];
  const focusAvailable = capabilities.has('STORAGE') && hasFocusConfiguration(connection);
  if (mode === 'FOCUS') return focusAvailable;
  if (mode === 'PROVIDER_API') return capabilities.has('COSTS');
  return focusAvailable || capabilities.has('COSTS');
}

export function hasFocusConfiguration(connection: CloudConnectionSummary): boolean {
  const keys = connection.providerCode === 'aws'
    ? ['awsFocusExportObjects', 'awsFocusExportLocations']
    : ['ociFocusReportObjects', 'ociFocusReportLocations'];
  return keys.some((key) => Array.isArray(connection.metadata?.[key]) && connection.metadata[key].length > 0);
}

export function hasMetricDefinitions(connection: CloudConnectionSummary): boolean {
  const key = connection.providerCode === 'aws' ? 'awsMetricDefinitions' : 'ociMetricDefinitions';
  return Array.isArray(connection.metadata?.[key]) && connection.metadata[key].length > 0;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new FinOpsBaseError(message, 'PROVIDER_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
