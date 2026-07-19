import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';

export type BillingSourceMode = 'AUTO' | 'FOCUS' | 'PROVIDER_API';
export type ResolvedBillingSource = 'FOCUS' | 'PROVIDER_API';

export function resolveBillingSource(job: CloudIngestionJobContext): ResolvedBillingSource {
  const configured = readBillingSourceMode(job.connection.metadata);
  if (configured === 'FOCUS' || configured === 'PROVIDER_API') return configured;
  return hasFocusSource(job) ? 'FOCUS' : 'PROVIDER_API';
}

export function readBillingSourceMode(metadata: Readonly<Record<string, unknown>> | undefined): BillingSourceMode {
  const value = metadata?.['billingSourceMode'];
  return value === 'FOCUS' || value === 'PROVIDER_API' ? value : 'AUTO';
}

export function hasFocusSource(job: CloudIngestionJobContext): boolean {
  const metadata = job.connection.metadata;
  if (metadata === undefined) return false;
  const keys = job.connection.providerCode === 'aws'
    ? ['awsFocusExportObjects', 'awsFocusExportLocations']
    : ['ociFocusReportObjects', 'ociFocusReportLocations'];
  return keys.some((key) => Array.isArray(metadata[key]) && metadata[key].length > 0);
}
