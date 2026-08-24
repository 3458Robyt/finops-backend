import { createHash } from 'node:crypto';
import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';

// v3 invalidates windows queued before the legacy uniqueness key was removed;
// those windows contain only MEAN rows and must be replayed for native stats.
export const OCI_TECHNICAL_METRICS_CONFIGURATION_VERSION = 'oci-technical-metrics-v3';

/**
 * Builds a deterministic, non-secret fingerprint for a provider ingestion
 * contract. It is stored with the job so a later metadata change cannot make
 * an old window appear covered by a different collection profile.
 */
export function buildIngestionConfigurationHash(input: {
  readonly providerCode: string;
  readonly sourceType: IngestionSourceType;
  readonly metadata: unknown;
  readonly requestContext?: Readonly<Record<string, unknown>>;
}): string {
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const sourceKey = sourceKeyFor(input.providerCode, input.sourceType);
  const payload = {
    version: input.providerCode === 'oci' && input.sourceType === 'TECHNICAL_METRIC'
      ? OCI_TECHNICAL_METRICS_CONFIGURATION_VERSION
      : 'ingestion-configuration-v1',
    providerCode: input.providerCode,
    sourceType: input.sourceType,
    sourceConfiguration: metadata[sourceKey] ?? null,
    requestContext: input.requestContext ?? null,
  };

  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export function sourceKeyFor(providerCode: string, sourceType: IngestionSourceType): string {
  if (sourceType === 'TECHNICAL_METRIC') {
    return providerCode === 'aws' ? 'awsMetricDefinitions' : 'ociMetricDefinitions';
  }
  if (sourceType === 'BILLING_EXPORT') {
    return providerCode === 'aws' ? 'awsFocusExportObjects' : 'ociFocusReportObjects';
  }
  return `${providerCode}:${sourceType}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
