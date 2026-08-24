import type { IngestionJobStatus, IngestionSourceType } from '../../domain/models/CloudConnection.js';
import { buildIngestionConfigurationHash } from './ingestionConfigurationHash.js';

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
  readonly lastValidatedAt: Date | null;
  readonly metadata: unknown;
  readonly credentials: readonly ScheduleableCredential[];
  readonly ingestionJobs: readonly ScheduleableIngestionJob[];
  readonly ingestionCoverageSegments?: readonly ScheduleableCoverageSegment[];
  readonly metricDefinitions?: readonly ScheduleableMetricDefinition[];
}

export interface ScheduleableCredential {
  readonly purpose: CredentialPurpose | string;
  readonly status: string;
}

export interface ScheduleableIngestionJob {
  readonly sourceType: IngestionSourceType | string;
  readonly status: IngestionJobStatus | string;
  readonly targetEnd: Date;
  readonly configurationHash?: string | null;
}

export interface IngestionScheduleOptions {
  readonly now: Date;
  /** Ventana informativa usada para el job de inventario; el proveedor puede ignorarla. */
  readonly inventoryWindowHours?: number;
  /** Tiempo mínimo entre dos lecturas completas del inventario de recursos. */
  readonly inventoryCooldownHours?: number;
  readonly metricWindowMinutes: number;
  readonly metricCooldownMinutes: number;
  readonly billingWindowHours: number;
  readonly billingCooldownHours: number;
  readonly maxAttempts: number;
  /** Días máximos de histórico técnico que el scheduler puede recuperar automáticamente. */
  readonly metricCatchupDays?: number;
  /** Edad máxima de una validación de capacidades antes de exigir otra. */
  readonly validationMaxAgeMinutes?: number;
}

export interface PlannedIngestionJob {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly providerCode: 'aws' | 'oci';
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly maxAttempts: number;
  readonly configurationHash: string;
  readonly requestContext?: Readonly<Record<string, unknown>>;
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

    for (const sourceType of ['INVENTORY', 'TECHNICAL_METRIC', 'BILLING_EXPORT'] as const) {
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
  if (connection.lastValidatedAt === null || connection.lastValidatedAt === undefined) {
    return { kind: 'skip', reason: 'La conexión debe validarse después de su última modificación.' };
  }

  const validationMaxAgeMinutes = options.validationMaxAgeMinutes ?? 24 * 60;
  const validationAgeMs = options.now.getTime() - connection.lastValidatedAt.getTime();
  if (!Number.isFinite(validationAgeMs) || validationAgeMs > validationMaxAgeMinutes * 60 * 1000) {
    return { kind: 'skip', reason: 'La validación de capacidades expiró; ejecuta una nueva validación antes de ingerir.' };
  }

  const capabilities = availableCapabilities(connection.metadata);
  if (!capabilities.has('IDENTITY')) {
    return { kind: 'skip', reason: 'La validación vigente no confirmó la identidad del proveedor.' };
  }

  if (!hasCredentialForSource(connection.credentials, sourceType)) {
    return { kind: 'skip', reason: 'No hay credencial activa con permisos esperados para esta fuente.' };
  }

  if (!hasMetadataForSource(providerCode, sourceType, connection.metadata, connection.metricDefinitions)) {
    return { kind: 'skip', reason: 'No hay metadata configurada para programar esta fuente sin inventar datos.' };
  }

  const requiredCapability = requiredCapabilityForSource(providerCode, sourceType, connection.metadata);
  if (!hasRequiredCapability(capabilities, requiredCapability)) {
    return {
      kind: 'skip',
      reason: requiredCapability === 'STORAGE_OR_COSTS'
        ? 'La validación vigente no confirmó STORAGE (FOCUS) ni COSTS (API directa) para facturación.'
        : `La validación vigente no confirmó la capacidad ${requiredCapability} para esta fuente.`,
    };
  }

  const requestContext = sourceType === 'TECHNICAL_METRIC'
    ? { interval: '30m', resolutionSeconds: 1800 }
    : undefined;
  const configurationHash = buildIngestionConfigurationHash({
    providerCode,
    sourceType,
    metadata: connection.metadata,
    ...(requestContext !== undefined ? { requestContext } : {}),
  });

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
  const recentCoverage = connection.ingestionCoverageSegments?.find((segment) => {
    return segment.sourceType === sourceType
      && (segment.status === 'COVERED' || segment.status === 'PARTIAL')
      && (segment.configurationHash === configurationHash || segment.configurationHash === undefined || segment.configurationHash === null)
      && segment.targetEnd >= freshnessThreshold;
  });
  const recentJob = recentCoverage === undefined ? connection.ingestionJobs.find((job) => {
    return (
      job.sourceType === sourceType &&
      (job.configurationHash === configurationHash
        || (sourceType !== 'TECHNICAL_METRIC' && (job.configurationHash === undefined || job.configurationHash === null))) &&
      completedOrActiveJobStatuses.has(job.status) &&
      job.targetEnd >= freshnessThreshold
    );
  }) : undefined;
  if (recentCoverage !== undefined) {
    return {
      kind: 'skip',
      reason: `La fuente ya tiene cobertura ${recentCoverage.status === 'PARTIAL' ? 'parcial' : 'reciente'} hasta ${recentCoverage.targetEnd.toISOString()}.`,
    };
  }
  if (recentJob !== undefined) {
    return {
      kind: 'skip',
      reason: `La fuente ya tiene cobertura reciente hasta ${recentJob.targetEnd.toISOString()}.`,
    };
  }

  const latestCoveredSegment = connection.ingestionCoverageSegments
    ?.filter((segment) => (
      segment.sourceType === sourceType
      && (segment.status === 'COVERED' || segment.status === 'PARTIAL')
      && (segment.configurationHash === configurationHash || segment.configurationHash === undefined || segment.configurationHash === null)
    ))
    .sort((left, right) => right.targetEnd.getTime() - left.targetEnd.getTime())[0];
  const latestCoveredJob = connection.ingestionJobs
    .filter((job) => (
      job.sourceType === sourceType
      && completedOrActiveJobStatuses.has(job.status)
      && job.configurationHash === configurationHash
    ))
    .sort((left, right) => right.targetEnd.getTime() - left.targetEnd.getTime())[0];
  const defaultStart = new Date(targetEnd.getTime() - windowMs);
  const catchupFloor = sourceType === 'TECHNICAL_METRIC'
    ? new Date(targetEnd.getTime() - (options.metricCatchupDays ?? 90) * 24 * 60 * 60 * 1000)
    : defaultStart;
  const latestCoveredEnd = latestCoveredSegment?.targetEnd ?? latestCoveredJob?.targetEnd;
  const targetStart = latestCoveredEnd === undefined
    ? (sourceType === 'TECHNICAL_METRIC' ? catchupFloor : defaultStart)
    : new Date(Math.max(catchupFloor.getTime(), latestCoveredEnd.getTime()));

  return {
    kind: 'job',
    job: {
      tenantId: connection.tenantId,
      cloudConnectionId: connection.id,
      providerCode,
      sourceType,
      targetStart,
      targetEnd,
      maxAttempts: options.maxAttempts,
      configurationHash,
      ...(requestContext !== undefined ? { requestContext } : {}),
      reason: sourceType === 'INVENTORY'
        ? 'Inventario de recursos habilitado y sin lectura reciente.'
        : sourceType === 'TECHNICAL_METRIC'
          ? 'Metricas tecnicas configuradas; se recupera la ventana faltante desde la última cobertura.'
          : 'Facturación configurada y sin job reciente.',
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

  if (sourceType === 'INVENTORY') {
    return activePurposes.has('OPERATIONAL') || activePurposes.has('INVENTORY_READ');
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
  metricDefinitions: readonly ScheduleableMetricDefinition[] | undefined,
): boolean {
  if (!isRecord(metadata)) {
    return sourceType === 'INVENTORY'
      || sourceType === 'BILLING_EXPORT'
      || (providerCode === 'oci' && sourceType === 'TECHNICAL_METRIC' && (metricDefinitions?.some((item) => item.enabled !== false) ?? false));
  }

  if (sourceType === 'INVENTORY') return true;

  if (providerCode === 'oci' && sourceType === 'TECHNICAL_METRIC') {
    return hasArrayItems(metadata['ociMetricDefinitions']) || (metricDefinitions?.some((item) => item.enabled !== false) ?? false);
  }
  if (providerCode === 'aws' && sourceType === 'TECHNICAL_METRIC') {
    return hasArrayItems(metadata['awsMetricDefinitions']);
  }
  if (providerCode === 'oci' && sourceType === 'BILLING_EXPORT') {
    if (billingSourceMode(metadata) !== 'FOCUS') return true;
    return hasArrayItems(metadata['ociFocusReportObjects'])
      || hasArrayItems(metadata['ociFocusReportLocations'])
      || billingSourceMode(metadata) === 'AUTO';
  }
  if (providerCode === 'aws' && sourceType === 'BILLING_EXPORT') {
    if (billingSourceMode(metadata) !== 'FOCUS') return true;
    return hasArrayItems(metadata['awsFocusExportObjects']) || hasArrayItems(metadata['awsFocusExportLocations']);
  }

  return false;
}

function requiredCapabilityForSource(
  providerCode: 'aws' | 'oci',
  sourceType: IngestionSourceType,
  metadata: unknown,
): 'INVENTORY' | 'METRICS' | 'STORAGE' | 'COSTS' | 'STORAGE_OR_COSTS' {
  if (sourceType === 'INVENTORY') return 'INVENTORY';
  if (sourceType === 'TECHNICAL_METRIC') return 'METRICS';
  if (!isRecord(metadata)) return 'STORAGE_OR_COSTS';

  const mode = billingSourceMode(metadata);
  if (mode === 'FOCUS') return 'STORAGE';
  if (mode === 'PROVIDER_API') return 'COSTS';

  const focusKeys = providerCode === 'aws'
    ? ['awsFocusExportObjects', 'awsFocusExportLocations']
    : ['ociFocusReportObjects', 'ociFocusReportLocations'];
  return focusKeys.some((key) => hasArrayItems(metadata[key])) ? 'STORAGE' : 'STORAGE_OR_COSTS';
}

export interface ScheduleableCoverageSegment {
  readonly sourceType: IngestionSourceType | string;
  readonly status: string;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly configurationHash?: string | null;
}

export interface ScheduleableMetricDefinition {
  readonly enabled?: boolean;
}

function hasRequiredCapability(
  capabilities: ReadonlySet<string>,
  required: 'INVENTORY' | 'METRICS' | 'STORAGE' | 'COSTS' | 'STORAGE_OR_COSTS',
): boolean {
  return required === 'STORAGE_OR_COSTS'
    ? capabilities.has('STORAGE') || capabilities.has('COSTS')
    : capabilities.has(required);
}

function availableCapabilities(metadata: unknown): ReadonlySet<string> {
  if (!isRecord(metadata)) return new Set();
  const validation = metadata['capabilityValidation'];
  if (!isRecord(validation) || !Array.isArray(validation['capabilities'])) return new Set();

  return new Set(validation['capabilities']
    .filter((item): item is Record<string, unknown> => isRecord(item) && item['status'] === 'AVAILABLE')
    .map((item) => String(item['capability'])));
}

function billingSourceMode(metadata: Record<string, unknown>): 'AUTO' | 'FOCUS' | 'PROVIDER_API' {
  const value = metadata['billingSourceMode'];
  return value === 'FOCUS' || value === 'PROVIDER_API' ? value : 'AUTO';
}

function normalizeProviderCode(providerCode: string): 'aws' | 'oci' | null {
  if (providerCode === 'aws' || providerCode === 'oci') {
    return providerCode;
  }

  return null;
}

function getWindowMs(sourceType: IngestionSourceType, options: IngestionScheduleOptions): number {
  if (sourceType === 'INVENTORY') {
    return (options.inventoryWindowHours ?? 24) * 60 * 60 * 1000;
  }

  if (sourceType === 'TECHNICAL_METRIC') {
    return options.metricWindowMinutes * 60 * 1000;
  }

  return options.billingWindowHours * 60 * 60 * 1000;
}

function getCooldownMs(sourceType: IngestionSourceType, options: IngestionScheduleOptions): number {
  if (sourceType === 'INVENTORY') {
    return (options.inventoryCooldownHours ?? 24) * 60 * 60 * 1000;
  }

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
