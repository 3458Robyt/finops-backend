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
  readonly lastValidatedAt?: Date | null;
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
    const capabilities = readCapabilityValidation(metadata);

    issues.push(...assessReadinessConnection({
      connectionId: connection.id,
      providerCode: connection.providerCode,
      credentialPurposes,
      metadataCounts,
    }));
    if (connection.lastValidatedAt === null || connection.lastValidatedAt === undefined) {
      issues.push({
        provider: connection.providerCode,
        connectionId: connection.id,
        severity: 'BLOCKER',
        capability: 'CREDENTIALS',
        message: 'La conexión todavía no tiene una validación guardada.',
        affectedData: ['Activación inicial'],
        action: 'Ejecuta “Validar acceso” antes de activar la sincronización.',
        actionCode: 'VALIDATE_ACCESS',
      });
    }
    issues.push(...capabilities.flatMap((capability): IngestionReadinessIssue[] => {
      if (capability.status === 'AVAILABLE' || capability.status === 'NOT_CONFIGURED') return [];
      return [{
        provider: connection.providerCode,
        connectionId: connection.id,
        severity: capability.status === 'DENIED' ? 'WARNING' : 'BLOCKER',
        capability: capability.capability === 'IDENTITY' ? 'CREDENTIALS' : capability.capability as IngestionReadinessIssue['capability'],
        message: capability.message,
        affectedData: affectedDataForCapability(capability.capability),
        action: capability.status === 'DENIED'
          ? 'Ajusta las policies de solo lectura en el proveedor y vuelve a validar.'
          : 'Comprueba la configuración y vuelve a ejecutar la validación.',
        actionCode: 'VALIDATE_ACCESS',
      }];
    }));
    if (connection.recentJobs.some((job) => job.status === 'FAILED')) {
      issues.push({
        provider: connection.providerCode,
        connectionId: connection.id,
        severity: 'WARNING',
        capability: 'JOBS',
        message: 'Una o más sincronizaciones recientes fallaron.',
        affectedData: ['Datos de las ventanas fallidas'],
        action: 'Revisa el error del job y reintenta solamente la fuente afectada.',
        actionCode: 'RETRY_FAILED_JOBS',
      });
    }

    const summary: IngestionReadinessConnectionSummary = {
      id: connection.id,
      name: connection.name,
      providerCode: connection.providerCode,
      ...(connection.defaultRegion !== null && connection.defaultRegion !== undefined
        ? { defaultRegion: connection.defaultRegion }
        : {}),
      ...(connection.lastValidatedAt !== null && connection.lastValidatedAt !== undefined
        ? { lastValidatedAt: connection.lastValidatedAt }
        : {}),
      onboardingStatus: resolveOnboardingStatus(connection, credentialPurposes, capabilities),
      credentialPurposes,
      capabilities,
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

  if (input.connections.length === 0) {
    issues.push({
      provider: 'global',
      severity: 'BLOCKER',
      capability: 'CONNECTION',
      message: `No hay conexiones cloud activas${input.missingProviderMessageSuffix ?? ''}.`,
      affectedData: ['Inventario', 'Costos', 'Métricas'],
      action: 'Crea o habilita una conexión OCI o AWS.',
      actionCode: 'CREATE_CONNECTION',
    });
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'BLOCKER'),
    generatedAt: input.generatedAt,
    connections,
    issues,
  };
}

export function assessReadinessConnection(input: {
  readonly connectionId: string;
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
      connectionId: input.connectionId,
      severity: 'BLOCKER',
      capability: 'CREDENTIALS',
      message: 'No hay una credencial operativa o de lectura activa para esta conexión.',
      affectedData: ['Inventario', 'Costos', 'Métricas'],
      action: 'Registra una credencial operativa de solo lectura y valida el acceso.',
      actionCode: 'CONFIGURE_CREDENTIALS',
    });
  }

  if (input.providerCode === 'oci') {
    if ((input.metadataCounts['ociMetricDefinitions'] ?? 0) === 0) {
      issues.push({ provider: 'oci', connectionId: input.connectionId, severity: 'WARNING', capability: 'METRICS', message: 'Falta configurar o descubrir métricas técnicas OCI.', affectedData: ['Métricas técnicas', 'Evidencia para recomendaciones'], action: 'Agrega al menos una definición OCI Monitoring vinculada a un recurso.', actionCode: 'CONFIGURE_METRICS' });
    }
    if (
      (input.metadataCounts['ociFocusReportObjects'] ?? 0) === 0 &&
      (input.metadataCounts['ociFocusReportLocations'] ?? 0) === 0
    ) {
      issues.push({ provider: 'oci', connectionId: input.connectionId, severity: 'WARNING', capability: 'STORAGE', message: 'FOCUS OCI no está configurado; AUTO puede usar la API directa.', affectedData: ['Costos FOCUS'], action: 'Configura un bucket/prefijo FOCUS o conserva AUTO para usar la API directa.', actionCode: 'CONFIGURE_FOCUS' });
    }
  }

  if (input.providerCode === 'aws') {
    if ((input.metadataCounts['awsMetricDefinitions'] ?? 0) === 0) {
      issues.push({ provider: 'aws', connectionId: input.connectionId, severity: 'WARNING', capability: 'METRICS', message: 'Falta configurar o descubrir métricas de CloudWatch.', affectedData: ['Métricas técnicas', 'Evidencia para recomendaciones'], action: 'Agrega al menos una definición CloudWatch vinculada a una instancia.', actionCode: 'CONFIGURE_METRICS' });
    }
    if (
      (input.metadataCounts['awsFocusExportObjects'] ?? 0) === 0 &&
      (input.metadataCounts['awsFocusExportLocations'] ?? 0) === 0
    ) {
      issues.push({ provider: 'aws', connectionId: input.connectionId, severity: 'WARNING', capability: 'STORAGE', message: 'FOCUS AWS no está configurado; AUTO puede usar Cost Explorer.', affectedData: ['Costos FOCUS'], action: 'Configura un bucket/prefijo FOCUS o conserva AUTO para usar Cost Explorer.', actionCode: 'CONFIGURE_FOCUS' });
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
    durationMs: resultSummary['durationMs'],
    providerCode: resultSummary['providerCode'],
    sourceType: resultSummary['sourceType'],
    apiCallCount: resultSummary['apiCallCount'],
    objectsProcessed: resultSummary['objectsProcessed'],
    focusRows: resultSummary['focusRows'],
    focusRowsInserted: resultSummary['focusRowsInserted'],
    costMetrics: resultSummary['costMetrics'],
    costMetricsInserted: resultSummary['costMetricsInserted'],
    metricSamples: resultSummary['metricSamples'],
    warnings: resultSummary['warnings'],
  };
}

function readCapabilityValidation(
  metadata: Readonly<Record<string, unknown>>,
): IngestionReadinessConnectionSummary['capabilities'] {
  const validation = metadata['capabilityValidation'];
  if (!isPlainRecord(validation) || !Array.isArray(validation['capabilities'])) return [];

  return validation['capabilities'].flatMap((item) => {
    if (!isPlainRecord(item)) return [];
    const capability = item['capability'];
    const status = item['status'];
    const message = item['message'];
    if (
      typeof capability !== 'string'
      || typeof message !== 'string'
      || !['AVAILABLE', 'NOT_CONFIGURED', 'DENIED', 'ERROR'].includes(String(status))
    ) return [];
    const checkedAt = typeof item['checkedAt'] === 'string' ? new Date(item['checkedAt']) : undefined;

    return [{
      capability,
      status: status as IngestionReadinessConnectionSummary['capabilities'][number]['status'],
      message,
      ...(checkedAt !== undefined && !Number.isNaN(checkedAt.getTime()) ? { checkedAt } : {}),
    }];
  });
}

function resolveOnboardingStatus(
  connection: IngestionReadinessConnectionInput,
  credentialPurposes: readonly string[],
  capabilities: IngestionReadinessConnectionSummary['capabilities'],
): IngestionReadinessConnectionSummary['onboardingStatus'] {
  if (credentialPurposes.length === 0) return 'NO_CREDENTIAL';
  if (connection.recentJobs.some((job) => job.status === 'PENDING' || job.status === 'RUNNING')) return 'SYNCING';
  if (connection.lastValidatedAt === null || connection.lastValidatedAt === undefined) return 'REQUIRES_VALIDATION';

  const available = capabilities.filter((item) => item.status === 'AVAILABLE').length;
  const failed = capabilities.some((item) => item.status === 'DENIED' || item.status === 'ERROR');
  if (failed) return available > 0 ? 'PARTIAL' : 'REQUIRES_ATTENTION';

  const successfulSources = new Set(connection.recentJobs
    .filter((job) => job.status === 'SUCCESS')
    .map((job) => job.sourceType));
  return ['INVENTORY', 'BILLING_EXPORT', 'TECHNICAL_METRIC'].every((source) => successfulSources.has(source))
    ? 'READY'
    : 'PARTIAL';
}

export function isValidCredentialEncryptionKey(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && Buffer.from(value, 'base64').length === 32;
}

export function isConfigured(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function affectedDataForCapability(capability: string): readonly string[] {
  if (capability === 'IDENTITY') return ['Todas las fuentes cloud'];
  if (capability === 'INVENTORY') return ['Inventario cloud', 'Relación por recurso'];
  if (capability === 'COSTS') return ['Costos por API directa'];
  if (capability === 'METRICS') return ['Métricas técnicas', 'Evidencia para recomendaciones'];
  if (capability === 'STORAGE') return ['Costos FOCUS'];
  return ['Datos cloud'];
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
