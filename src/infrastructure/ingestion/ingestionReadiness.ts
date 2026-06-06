import type {
  IngestionReadinessConnectionSummary,
  IngestionReadinessIssue,
  IngestionReadinessSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type { IngestionSourceType, ProviderCode } from '../../domain/models/CloudConnection.js';

export interface IngestionReadinessConnectionInput {
  readonly id: string;
  readonly name: string;
  readonly providerCode: ProviderCode;
  readonly defaultRegion?: string | null;
  readonly metadata: unknown;
  readonly credentialPurposes: readonly string[];
  readonly recentJobs: readonly IngestionReadinessJobInput[];
}

export interface IngestionReadinessJobInput {
  readonly id: string;
  readonly sourceType: IngestionSourceType | string;
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | string;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly completedAt?: Date | null;
  readonly errorMessage?: string | null;
  readonly resultSummary: unknown;
}

export interface BuildIngestionReadinessInput {
  readonly generatedAt: Date;
  readonly connections: readonly IngestionReadinessConnectionInput[];
  readonly globalIssues?: readonly IngestionReadinessIssue[];
  readonly missingProviderMessageSuffix?: string;
}

export function buildIngestionReadinessSummary(
  input: BuildIngestionReadinessInput,
): IngestionReadinessSummary {
  const issues: IngestionReadinessIssue[] = [...(input.globalIssues ?? [])];
  const connections = input.connections.map((connection) => {
    const metadata = isPlainRecord(connection.metadata) ? connection.metadata : {};
    const credentialPurposes = [...new Set(connection.credentialPurposes)].sort();
    const metadataCounts = summarizeReadinessMetadata(connection.providerCode, metadata);

    issues.push(...assessReadinessConnection({
      providerCode: connection.providerCode,
      credentialPurposes,
      metadataCounts,
    }));

    const summary: IngestionReadinessConnectionSummary = {
      id: connection.id,
      name: connection.name,
      providerCode: connection.providerCode,
      ...(connection.defaultRegion !== null && connection.defaultRegion !== undefined
        ? { defaultRegion: connection.defaultRegion }
        : {}),
      credentialPurposes,
      metadataCounts,
      recentJobs: connection.recentJobs.map((job) => ({
        id: job.id,
        sourceType: job.sourceType as IngestionSourceType,
        status: job.status as IngestionReadinessConnectionSummary['recentJobs'][number]['status'],
        targetStart: job.targetStart,
        targetEnd: job.targetEnd,
        ...(job.completedAt !== null && job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
        hasError: job.errorMessage !== null && job.errorMessage !== undefined,
        summary: summarizeReadinessJobResult(job.resultSummary),
      })),
    };

    return summary;
  });

  for (const provider of ['aws', 'oci'] as const) {
    if (!input.connections.some((connection) => connection.providerCode === provider)) {
      issues.push({
        provider,
        severity: provider === 'aws' ? 'WARNING' : 'BLOCKER',
        message: `No active ${provider.toUpperCase()} cloud connection found${input.missingProviderMessageSuffix ?? ''}.`,
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'BLOCKER'),
    generatedAt: input.generatedAt,
    connections,
    issues,
  };
}

export function assessReadinessConnection(input: {
  readonly providerCode: ProviderCode;
  readonly credentialPurposes: readonly string[];
  readonly metadataCounts: Readonly<Record<string, number>>;
}): readonly IngestionReadinessIssue[] {
  const issues: IngestionReadinessIssue[] = [];
  const hasOperationalCredential = input.credentialPurposes.some((purpose) => {
    return ['OPERATIONAL', 'METRICS_READ', 'BILLING_EXPORT_READ', 'STORAGE_READ'].includes(purpose);
  });
  if (!hasOperationalCredential) {
    issues.push({
      provider: input.providerCode,
      severity: 'BLOCKER',
      message: 'No active operational/read credential is stored for this provider.',
    });
  }

  if (input.providerCode === 'oci') {
    if ((input.metadataCounts['ociMetricDefinitions'] ?? 0) === 0) {
      issues.push({ provider: 'oci', severity: 'WARNING', message: 'Missing metadata.ociMetricDefinitions for technical metrics.' });
    }
    if (
      (input.metadataCounts['ociFocusReportObjects'] ?? 0) === 0 &&
      (input.metadataCounts['ociFocusReportLocations'] ?? 0) === 0
    ) {
      issues.push({ provider: 'oci', severity: 'WARNING', message: 'Missing OCI FOCUS object/prefix metadata for billing exports.' });
    }
  }

  if (input.providerCode === 'aws') {
    if ((input.metadataCounts['awsMetricDefinitions'] ?? 0) === 0) {
      issues.push({ provider: 'aws', severity: 'WARNING', message: 'Missing metadata.awsMetricDefinitions for CloudWatch metrics.' });
    }
    if (
      (input.metadataCounts['awsFocusExportObjects'] ?? 0) === 0 &&
      (input.metadataCounts['awsFocusExportLocations'] ?? 0) === 0
    ) {
      issues.push({ provider: 'aws', severity: 'WARNING', message: 'Missing AWS FOCUS object/prefix metadata for billing exports.' });
    }
  }

  return issues;
}

export function summarizeReadinessMetadata(
  provider: ProviderCode,
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  const keys = provider === 'aws'
    ? ['awsMetricDefinitions', 'awsFocusExportObjects', 'awsFocusExportLocations']
    : ['ociMetricDefinitions', 'ociFocusReportObjects', 'ociFocusReportLocations'];

  return Object.fromEntries(keys.map((key) => [key, Array.isArray(metadata[key]) ? metadata[key].length : 0]));
}

export function summarizeReadinessJobResult(resultSummary: unknown): Readonly<Record<string, unknown>> | null {
  if (!isPlainRecord(resultSummary)) {
    return null;
  }

  return {
    providerCode: resultSummary['providerCode'],
    sourceType: resultSummary['sourceType'],
    apiCallCount: resultSummary['apiCallCount'],
    objectsProcessed: resultSummary['objectsProcessed'],
    focusRows: resultSummary['focusRows'],
    metricSamples: resultSummary['metricSamples'],
    warnings: resultSummary['warnings'],
  };
}

export function isValidCredentialEncryptionKey(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && Buffer.from(value, 'base64').length === 32;
}

export function isConfigured(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
