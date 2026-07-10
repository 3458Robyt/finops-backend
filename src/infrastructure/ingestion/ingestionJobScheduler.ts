import type { IngestionJobStatus, IngestionSourceType } from '../../domain/models/CloudConnection.js';

type CredentialPurpose =
  | 'TEMPORARY_ADMIN'
  | 'OPERATIONAL'
  | 'BILLING_EXPORT_READ'
  | 'INVENTORY_READ'
  | 'METRICS_READ'
  | 'STORAGE_READ'
  | 'STORAGE_WRITE';

export interface ScheduleableIngestionConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly providerCode: string;
  readonly metadata: unknown;
  readonly credentials: readonly ScheduleableCredential[];
  readonly ingestionJobs: readonly ScheduleableIngestionJob[];
}

export interface ScheduleableCredential {
  readonly purpose: CredentialPurpose | string;
  readonly status: string;
}

export interface ScheduleableIngestionJob {
  readonly sourceType: IngestionSourceType | string;
  readonly status: IngestionJobStatus | string;
  readonly targetEnd: Date;
}

export interface IngestionScheduleOptions {
  readonly now: Date;
  readonly metricWindowMinutes: number;
  readonly metricCooldownMinutes: number;
  readonly billingWindowHours: number;
  readonly billingCooldownHours: number;
  readonly maxAttempts: number;
}

export interface PlannedIngestionJob {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly providerCode: 'aws' | 'oci';
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly maxAttempts: number;
  readonly reason: string;
}

export interface SkippedIngestionSchedule {
  readonly cloudConnectionId: string;
  readonly providerCode: string;
  readonly sourceType: IngestionSourceType;
  readonly reason: string;
}

export interface IngestionSchedulePlan {
  readonly jobs: readonly PlannedIngestionJob[];
  readonly skipped: readonly SkippedIngestionSchedule[];
}

const activeJobStatuses = new Set<string>(['PENDING', 'RUNNING']);
const completedOrActiveJobStatuses = new Set<string>(['PENDING', 'RUNNING', 'SUCCESS']);

export function buildIngestionSchedulePlan(
  connections: readonly ScheduleableIngestionConnection[],
  options: IngestionScheduleOptions,
): IngestionSchedulePlan {
  const jobs: PlannedIngestionJob[] = [];
  const skipped: SkippedIngestionSchedule[] = [];

  for (const connection of connections) {
    const providerCode = normalizeProviderCode(connection.providerCode);
    if (providerCode === null) {
      continue;
    }

    for (const sourceType of ['TECHNICAL_METRIC', 'BILLING_EXPORT'] as const) {
      const decision = evaluateSource(connection, providerCode, sourceType, options);
      if (decision.kind === 'job') {
        jobs.push(decision.job);
      } else {
        skipped.push({
          cloudConnectionId: connection.id,
          providerCode,
          sourceType,
          reason: decision.reason,
        });
      }
    }
  }

  return { jobs, skipped };
}

function evaluateSource(
  connection: ScheduleableIngestionConnection,
  providerCode: 'aws' | 'oci',
  sourceType: IngestionSourceType,
  options: IngestionScheduleOptions,
): { readonly kind: 'job'; readonly job: PlannedIngestionJob } | { readonly kind: 'skip'; readonly reason: string } {
  if (!hasCredentialForSource(connection.credentials, sourceType)) {
    return { kind: 'skip', reason: 'No hay credencial activa con permisos esperados para esta fuente.' };
  }

  if (!hasMetadataForSource(providerCode, sourceType, connection.metadata)) {
    return { kind: 'skip', reason: 'No hay metadata configurada para programar esta fuente sin inventar datos.' };
  }

  const runningJob = connection.ingestionJobs.find((job) => {
    return job.sourceType === sourceType && activeJobStatuses.has(job.status);
  });
  if (runningJob !== undefined) {
    return { kind: 'skip', reason: `Ya existe un job ${runningJob.status} para esta fuente.` };
  }

  const targetEnd = options.now;
  const windowMs = getWindowMs(sourceType, options);
  const cooldownMs = getCooldownMs(sourceType, options);
  const freshnessThreshold = new Date(targetEnd.getTime() - cooldownMs);
  const recentJob = connection.ingestionJobs.find((job) => {
    return (
      job.sourceType === sourceType &&
      completedOrActiveJobStatuses.has(job.status) &&
      job.targetEnd >= freshnessThreshold
    );
  });
  if (recentJob !== undefined) {
    return {
      kind: 'skip',
      reason: `La fuente ya tiene cobertura reciente hasta ${recentJob.targetEnd.toISOString()}.`,
    };
  }

  return {
    kind: 'job',
    job: {
      tenantId: connection.tenantId,
      cloudConnectionId: connection.id,
      providerCode,
      sourceType,
      targetStart: new Date(targetEnd.getTime() - windowMs),
      targetEnd,
      maxAttempts: options.maxAttempts,
      reason: sourceType === 'TECHNICAL_METRIC'
        ? 'Metricas tecnicas configuradas y sin job reciente.'
        : 'Export FOCUS configurado y sin job reciente.',
    },
  };
}

function hasCredentialForSource(
  credentials: readonly ScheduleableCredential[],
  sourceType: IngestionSourceType,
): boolean {
  const activePurposes = new Set(
    credentials
      .filter((credential) => credential.status === 'ACTIVE')
      .map((credential) => credential.purpose),
  );

  if (sourceType === 'TECHNICAL_METRIC') {
    return activePurposes.has('OPERATIONAL') || activePurposes.has('METRICS_READ');
  }

  return (
    activePurposes.has('OPERATIONAL') ||
    activePurposes.has('BILLING_EXPORT_READ') ||
    activePurposes.has('STORAGE_READ')
  );
}

function hasMetadataForSource(
  providerCode: 'aws' | 'oci',
  sourceType: IngestionSourceType,
  metadata: unknown,
): boolean {
  if (!isRecord(metadata)) {
    return false;
  }

  if (providerCode === 'oci' && sourceType === 'TECHNICAL_METRIC') {
    return hasArrayItems(metadata['ociMetricDefinitions']);
  }
  if (providerCode === 'aws' && sourceType === 'TECHNICAL_METRIC') {
    return hasArrayItems(metadata['awsMetricDefinitions']);
  }
  if (providerCode === 'oci' && sourceType === 'BILLING_EXPORT') {
    return hasArrayItems(metadata['ociFocusReportObjects']) || hasArrayItems(metadata['ociFocusReportLocations']);
  }
  if (providerCode === 'aws' && sourceType === 'BILLING_EXPORT') {
    return hasArrayItems(metadata['awsFocusExportObjects']) || hasArrayItems(metadata['awsFocusExportLocations']);
  }

  return false;
}

function normalizeProviderCode(providerCode: string): 'aws' | 'oci' | null {
  if (providerCode === 'aws' || providerCode === 'oci') {
    return providerCode;
  }

  return null;
}

function getWindowMs(sourceType: IngestionSourceType, options: IngestionScheduleOptions): number {
  if (sourceType === 'TECHNICAL_METRIC') {
    return options.metricWindowMinutes * 60 * 1000;
  }

  return options.billingWindowHours * 60 * 60 * 1000;
}

function getCooldownMs(sourceType: IngestionSourceType, options: IngestionScheduleOptions): number {
  if (sourceType === 'TECHNICAL_METRIC') {
    return options.metricCooldownMinutes * 60 * 1000;
  }

  return options.billingCooldownHours * 60 * 60 * 1000;
}

function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
