import type {
  ICloudConnectionRepository,
  CloudMetricDefinitionSummary,
  IngestionJobSummary,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import { buildBackfillWindows, currentMinute } from '../cloudConnectionPolicies.js';
import { buildIngestionConfigurationHash } from '../../../infrastructure/ingestion/ingestionConfigurationHash.js';
import type {
  QueueTechnicalBackfillInput,
  TechnicalBackfillResult,
  TechnicalBackfillWindow,
} from './CloudConnectionContracts.js';

/** Queues bounded, idempotent technical-metric windows for a cloud connection. */
export class CloudIngestionBackfillService {
  constructor(private readonly repository: ICloudConnectionRepository) {}

  public async queueTechnicalMetricBackfill(
    input: QueueTechnicalBackfillInput,
  ): Promise<TechnicalBackfillResult> {
    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    const lookbackDays = this.resolveLookbackDays(input.lookbackDays);
    const windowHours = this.resolveWindowHours(input.windowHours);
    const rangeEnd = currentMinute();
    const rangeStart = new Date(rangeEnd.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const windows = this.buildProviderWindows(connection.providerCode, rangeStart, rangeEnd, windowHours);
    const catalogDefinitions = connection.providerCode === 'oci' && this.repository.listEnabledMetricDefinitions !== undefined
      ? await this.repository.listEnabledMetricDefinitions(input.tenantId, input.cloudConnectionId)
      : [];
    const ingestionMetadata = mergeMetricCatalogIntoMetadata(connection.metadata, catalogDefinitions);
    const definitionCount = catalogDefinitions.length > 0
      ? catalogDefinitions.length
      : this.countMetricDefinitions(connection.metadata);
    if (connection.providerCode === 'oci' && definitionCount === 0) {
      throw new FinOpsBaseError(
        'No hay métricas OCI confirmadas para esta conexión. Ejecuta el descubrimiento y confirma al menos una métrica antes del backfill.',
        'VALIDATION_ERROR',
      );
    }
    const existingJobs = [...await this.repository.listIngestionJobsForConnectionRange({
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      sourceType: 'TECHNICAL_METRIC',
      targetStart: rangeStart,
      targetEnd: rangeEnd,
    })];

    const createdJobs: IngestionJobSummary[] = [];
    const skippedWindows: TechnicalBackfillWindow[] = [];
    for (const window of windows) {
      const requestContext = {
        interval: window.interval,
        resolutionSeconds: intervalSeconds(window.interval),
        scopeKey: `technical:${window.interval}`,
      };
      const configurationHash = buildIngestionConfigurationHash({
        providerCode: connection.providerCode,
        sourceType: 'TECHNICAL_METRIC',
        metadata: ingestionMetadata,
        requestContext,
      });
      if (this.isCovered(existingJobs, window, configurationHash)) {
        skippedWindows.push(window);
        continue;
      }

      const job = await this.repository.createIngestionJob({
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: 'TECHNICAL_METRIC',
        ...(input.userId !== undefined ? { requestedByUserId: input.userId } : {}),
        targetStart: window.targetStart,
        targetEnd: window.targetEnd,
        maxAttempts: 3,
        configurationHash,
        requestContext,
      });
      createdJobs.push(job);
      existingJobs.push({ ...job, configurationHash });
    }

    return {
      cloudConnectionId: input.cloudConnectionId,
      sourceType: 'TECHNICAL_METRIC',
      lookbackDays,
      windowHours,
      rangeStart,
      rangeEnd,
      createdJobs,
      skippedWindows,
      estimatedApiCalls: windows.length * definitionCount * 4,
    };
  }

  private buildProviderWindows(
    providerCode: string,
    rangeStart: Date,
    rangeEnd: Date,
    windowHours: number,
  ): readonly TechnicalBackfillWindow[] {
    if (providerCode !== 'oci') {
      return buildBackfillWindows(rangeStart, rangeEnd, windowHours)
        .map((window) => ({ ...window, interval: '30m' as const }));
    }

    const sevenDayBoundary = new Date(rangeEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDayBoundary = new Date(rangeEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDayBoundary = new Date(rangeEnd.getTime() - 90 * 24 * 60 * 60 * 1000);
    const windows: TechnicalBackfillWindow[] = [];
    const historicalStart = new Date(Math.max(rangeStart.getTime(), ninetyDayBoundary.getTime()));
    const historicalEnd = new Date(Math.min(rangeEnd.getTime(), thirtyDayBoundary.getTime()));
    if (historicalStart.getTime() < historicalEnd.getTime()) {
      windows.push(...buildBackfillWindows(
        historicalStart,
        historicalEnd,
        24,
      ).map((window) => ({ ...window, interval: '1h' as const })));
    }
    const mediumStart = new Date(Math.max(rangeStart.getTime(), thirtyDayBoundary.getTime()));
    const mediumEnd = new Date(Math.min(rangeEnd.getTime(), sevenDayBoundary.getTime()));
    if (mediumStart.getTime() < mediumEnd.getTime()) {
      windows.push(...buildBackfillWindows(mediumStart, mediumEnd, Math.min(windowHours, 12))
        .map((window) => ({ ...window, interval: '5m' as const })));
    }
    const recentStart = new Date(Math.max(rangeStart.getTime(), sevenDayBoundary.getTime()));
    if (recentStart.getTime() < rangeEnd.getTime()) {
      windows.push(...buildBackfillWindows(recentStart, rangeEnd, Math.min(windowHours, 6))
        .map((window) => ({ ...window, interval: '1m' as const })));
    }
    return windows;
  }

  private isCovered(
    jobs: readonly {
      readonly status: string;
      readonly targetStart: Date;
      readonly targetEnd: Date;
      readonly configurationHash?: string;
    }[],
    window: TechnicalBackfillWindow,
    configurationHash: string,
  ): boolean {
    return jobs.some((job) =>
      job.status !== 'FAILED'
      && job.status !== 'CANCELLED'
      && job.configurationHash === configurationHash
      && job.targetStart.getTime() <= window.targetStart.getTime()
      && job.targetEnd.getTime() >= window.targetEnd.getTime());
  }

  private countMetricDefinitions(metadata: unknown): number {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return 0;
    const definitions = (metadata as Record<string, unknown>)['ociMetricDefinitions'];
    return Array.isArray(definitions) ? definitions.length : 0;
  }

  private resolveLookbackDays(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 90;
    const normalized = Math.floor(value);
    if (normalized < 1 || normalized > 90) {
      throw new FinOpsBaseError('El rango histórico debe estar entre 1 y 90 días.', 'VALIDATION_ERROR');
    }
    return normalized;
  }

  private resolveWindowHours(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 24;
    const normalized = Math.floor(value);
    if (normalized < 1 || normalized > 24) {
      throw new FinOpsBaseError('La ventana debe estar entre 1 y 24 horas.', 'VALIDATION_ERROR');
    }
    return normalized;
  }
}

function mergeMetricCatalogIntoMetadata(
  metadataValue: Readonly<Record<string, unknown>> | undefined,
  definitions: readonly CloudMetricDefinitionSummary[],
): Readonly<Record<string, unknown>> | undefined {
  const metadata = { ...(metadataValue ?? {}) };
  if (definitions.length > 0) {
    metadata['ociMetricDefinitions'] = definitions.map((definition) => ({
      compartmentId: definition.compartmentId,
      namespace: definition.namespace,
      metricName: definition.metricName,
      resourceId: definition.externalResourceId,
      ...(definition.regionId === undefined ? {} : { regionId: definition.regionId }),
      ...(definition.dimensions === undefined ? {} : { dimensions: definition.dimensions }),
      ...(definition.metricUnit === undefined ? {} : { unit: definition.metricUnit }),
      statistics: definition.statistics,
    }));
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function intervalSeconds(interval: TechnicalBackfillWindow['interval']): number {
  switch (interval) {
    case '1m': return 60;
    case '5m': return 300;
    case '30m': return 1800;
    case '1h': return 3600;
    default: return 1800;
  }
}
