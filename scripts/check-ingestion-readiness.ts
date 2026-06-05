import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { ProviderCode } from '../src/domain/models/CloudConnection.js';

interface ReadinessIssue {
  readonly provider: ProviderCode | 'global';
  readonly severity: 'INFO' | 'WARNING' | 'BLOCKER';
  readonly message: string;
}

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const connections = await prisma.cloudConnection.findMany({
    where: {
      providerCode: { in: ['aws', 'oci'] },
      status: 'ACTIVE',
    },
    orderBy: [{ providerCode: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      providerCode: true,
      defaultRegion: true,
      metadata: true,
      credentials: {
        where: { status: 'ACTIVE' },
        select: { purpose: true, label: true, externalPrincipalId: true },
      },
      ingestionJobs: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          sourceType: true,
          status: true,
          targetStart: true,
          targetEnd: true,
          errorMessage: true,
          resultSummary: true,
          completedAt: true,
        },
      },
    },
  });

  const issues: ReadinessIssue[] = [];
  if (!isConfigured(process.env['DATABASE_URL'])) {
    issues.push({ provider: 'global', severity: 'BLOCKER', message: 'DATABASE_URL is not configured.' });
  }
  if (!isValidCredentialKey(process.env['CREDENTIAL_ENCRYPTION_KEY'])) {
    issues.push({
      provider: 'global',
      severity: 'BLOCKER',
      message: 'CREDENTIAL_ENCRYPTION_KEY is missing or is not a 32-byte base64 key.',
    });
  }

  const summaries = connections.map((connection) => {
    const metadata = isRecord(connection.metadata) ? connection.metadata : {};
    const credentialPurposes = [...new Set(connection.credentials.map((credential) => credential.purpose))].sort();
    const metadataCounts = summarizeMetadata(connection.providerCode, metadata);

    issues.push(...assessConnection({
      providerCode: connection.providerCode,
      credentialPurposes,
      metadataCounts,
    }));

    return {
      id: connection.id,
      name: connection.name,
      providerCode: connection.providerCode,
      defaultRegion: connection.defaultRegion,
      credentialPurposes,
      metadataCounts,
      recentJobs: connection.ingestionJobs.map((job) => ({
        id: job.id,
        sourceType: job.sourceType,
        status: job.status,
        targetStart: job.targetStart,
        targetEnd: job.targetEnd,
        completedAt: job.completedAt,
        hasError: job.errorMessage !== null,
        summary: summarizeJobResult(job.resultSummary),
      })),
    };
  });

  for (const provider of ['aws', 'oci'] as const) {
    if (!connections.some((connection) => connection.providerCode === provider)) {
      issues.push({
        provider,
        severity: provider === 'aws' ? 'WARNING' : 'BLOCKER',
        message: `No active ${provider.toUpperCase()} cloud connection found.`,
      });
    }
  }

  console.log(JSON.stringify({
    ok: !issues.some((issue) => issue.severity === 'BLOCKER'),
    generatedAt: new Date().toISOString(),
    connections: summaries,
    issues,
  }, null, 2));

  await prisma.$disconnect();
}

function assessConnection(input: {
  readonly providerCode: ProviderCode;
  readonly credentialPurposes: readonly string[];
  readonly metadataCounts: Readonly<Record<string, number>>;
}): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
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

function summarizeMetadata(provider: ProviderCode, metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, number>> {
  const keys = provider === 'aws'
    ? ['awsMetricDefinitions', 'awsFocusExportObjects', 'awsFocusExportLocations']
    : ['ociMetricDefinitions', 'ociFocusReportObjects', 'ociFocusReportLocations'];

  return Object.fromEntries(keys.map((key) => [key, Array.isArray(metadata[key]) ? metadata[key].length : 0]));
}

function summarizeJobResult(resultSummary: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(resultSummary)) {
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

function isConfigured(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function isValidCredentialKey(value: string | undefined): boolean {
  if (!isConfigured(value)) {
    return false;
  }

  return Buffer.from(value, 'base64').length === 32;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
