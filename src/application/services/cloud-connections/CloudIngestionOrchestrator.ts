import type {
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobHistoryItem,
  IngestionJobSummary,
  IngestionReadinessSummary,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  IngestionSourceType,
} from '../../../domain/models/CloudConnection.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import {
  availableCapabilities,
  currentMinute,
  hasMetricDefinitions,
  hasUsableBillingSource,
  hasUsableValidation,
} from '../cloudConnectionPolicies.js';
import type {
  ActivateCloudConnectionInput,
  ActivateCloudConnectionResult,
  ManageIngestionJobsInput,
  QueueIngestionInput,
  QueueTechnicalBackfillInput,
  TechnicalBackfillResult,
} from './CloudConnectionContracts.js';
import { CloudIngestionBackfillService } from './CloudIngestionBackfillService.js';

export class CloudIngestionOrchestrator {
  private readonly backfill: CloudIngestionBackfillService;

  constructor(private readonly repository: ICloudConnectionRepository) {
    this.backfill = new CloudIngestionBackfillService(repository);
  }

  public async activateConnection(
    input: ActivateCloudConnectionInput,
  ): Promise<ActivateCloudConnectionResult> {
    const connection = await this.requireConnection(input.tenantId, input.cloudConnectionId);
    if (connection.status !== 'ACTIVE') {
      throw new FinOpsBaseError('Habilita la conexión antes de iniciar la sincronización.', 'VALIDATION_ERROR');
    }
    if (!hasUsableValidation(connection)) {
      throw new FinOpsBaseError(
        'Valida la identidad y al menos una capacidad de datos antes de activar la cuenta.',
        'VALIDATION_ERROR',
      );
    }
    const now = currentMinute();
    const createdJobs: IngestionJobSummary[] = [];
    const skipped: IngestionSourceType[] = [];
    const unavailable: IngestionSourceType[] = [];
    const capabilities = availableCapabilities(connection);
    const billingLookbackDays = this.resolveRangeDays(input.billingLookbackDays, 30, 366, 'billingLookbackDays');

    for (const request of [
      {
        sourceType: 'INVENTORY' as const,
        targetStart: new Date(now.getTime() - 5 * 60 * 1000),
        targetEnd: now,
      },
      {
        sourceType: 'BILLING_EXPORT' as const,
        targetStart: new Date(now.getTime() - billingLookbackDays * 24 * 60 * 60 * 1000),
        targetEnd: now,
      },
    ]) {
      const supported = request.sourceType === 'INVENTORY'
        ? capabilities.has('INVENTORY')
        : hasUsableBillingSource(connection, capabilities);
      if (!supported) {
        unavailable.push(request.sourceType);
        continue;
      }
      const job = await this.queueIfUncovered({ ...input, ...request });
      if (job === null) skipped.push(request.sourceType);
      else createdJobs.push(job);
    }

    if (capabilities.has('METRICS') && hasMetricDefinitions(connection)) {
      const backfill = await this.backfill.queueTechnicalMetricBackfill({
        tenantId: input.tenantId,
        userId: input.userId,
        cloudConnectionId: input.cloudConnectionId,
        ...(input.metricLookbackDays !== undefined ? { lookbackDays: input.metricLookbackDays } : {}),
        ...(input.metricWindowHours !== undefined ? { windowHours: input.metricWindowHours } : {}),
      });
      createdJobs.push(...backfill.createdJobs);
      if (backfill.createdJobs.length === 0) skipped.push('TECHNICAL_METRIC');
    } else {
      unavailable.push('TECHNICAL_METRIC');
    }

    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId, actorUserId: input.userId,
      action: 'CLOUD_CONNECTION_ACTIVATED', entityType: 'CLOUD_CONNECTION', entityId: input.cloudConnectionId,
      metadata: { createdJobIds: createdJobs.map((job) => job.id), skipped, unavailable },
    });

    return { cloudConnectionId: input.cloudConnectionId, createdJobs, skipped, unavailable };
  }

  public async queueIngestion(input: QueueIngestionInput): Promise<IngestionJobSummary> {
    if (input.targetEnd <= input.targetStart) {
      throw new FinOpsBaseError('La fecha final debe ser posterior a la fecha inicial.', 'VALIDATION_ERROR');
    }

    const connection = await this.repository.findCloudConnectionForTenant(
      input.tenantId,
      input.cloudConnectionId,
    );

    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    const jobInput: CreateIngestionJobInput = {
      tenantId: input.tenantId,
      cloudConnectionId: input.cloudConnectionId,
      sourceType: input.sourceType,
      requestedByUserId: input.userId,
      targetStart: input.targetStart,
      targetEnd: input.targetEnd,
    };

    return this.repository.createIngestionJob(jobInput);
  }

  public async retryFailedIngestionJobs(input: ManageIngestionJobsInput): Promise<readonly IngestionJobSummary[]> {
    await this.requireConnection(input.tenantId, input.cloudConnectionId);
    const failed = await this.repository.listFailedIngestionJobsForConnection(
      input.tenantId,
      input.cloudConnectionId,
      input.sourceType,
    );
    const jobs: IngestionJobSummary[] = [];
    const queuedWindows = new Set<string>();
    for (const previous of failed) {
      const windowKey = `${previous.sourceType}:${previous.targetStart.toISOString()}:${previous.targetEnd.toISOString()}`;
      if (queuedWindows.has(windowKey)) continue;
      queuedWindows.add(windowKey);
      jobs.push(await this.repository.createIngestionJob({
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: previous.sourceType,
        requestedByUserId: input.userId,
        targetStart: previous.targetStart,
        targetEnd: previous.targetEnd,
      }));
    }
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_INGESTION_FAILED_RETRIED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { sourceType: input.sourceType, failedJobs: failed.length, queuedJobs: jobs.length },
    });
    return jobs;
  }

  public async cancelPendingIngestionJobs(input: ManageIngestionJobsInput): Promise<number> {
    await this.requireConnection(input.tenantId, input.cloudConnectionId);
    const cancelled = await this.repository.cancelPendingIngestionJobs(
      input.tenantId,
      input.cloudConnectionId,
      input.sourceType,
    );
    await this.repository.createCloudAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'CLOUD_INGESTION_PENDING_CANCELLED',
      entityType: 'CLOUD_CONNECTION',
      entityId: input.cloudConnectionId,
      metadata: { sourceType: input.sourceType, cancelled },
    });
    return cancelled;
  }

  public async queueTechnicalMetricBackfill(
    input: QueueTechnicalBackfillInput,
  ): Promise<TechnicalBackfillResult> {
    return this.backfill.queueTechnicalMetricBackfill(input);
  }

  public async getHealth(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<IngestionHealthSummary> {
    const health = await this.repository.getIngestionHealth(tenantId, cloudConnectionId);

    if (health === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    return health;
  }

  /**
   * Lista el historial de trabajos de ingesta del tenant (todas sus conexiones),
   * del más reciente al más antiguo. El `limit` se acota al rango [1, 200] con
   * un valor por defecto de 50.
   */
  public listIngestionHistory(
    tenantId: string,
    limit?: number,
    includeArchived = false,
  ): Promise<readonly IngestionJobHistoryItem[]> {
    return this.repository.listIngestionJobsForTenant(tenantId, this.clampLimit(limit), includeArchived);
  }

  public getIngestionJob(tenantId: string, jobId: string): Promise<IngestionJobHistoryItem> {
    return this.repository.getIngestionJobForTenant(tenantId, jobId).then((job) => {
      if (job === null) throw new FinOpsBaseError('El trabajo de ingesta no existe o no pertenece al tenant activo.', 'NOT_FOUND');
      return job;
    });
  }

  public async cancelIngestionJob(tenantId: string, jobId: string, userId: string): Promise<IngestionJobHistoryItem> {
    const job = await this.repository.requestIngestionJobCancellation(tenantId, jobId, userId);
    if (job === null) throw new FinOpsBaseError('El trabajo de ingesta no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    await this.repository.createCloudAuditEvent({
      tenantId, actorUserId: userId, action: 'CLOUD_INGESTION_JOB_CANCEL_REQUESTED', entityType: 'CLOUD_CONNECTION', entityId: job.cloudConnectionId,
      metadata: { jobId, status: job.status },
    });
    return job;
  }

  public async archiveIngestionJob(tenantId: string, jobId: string, userId: string): Promise<IngestionJobHistoryItem> {
    const job = await this.repository.archiveIngestionJob(tenantId, jobId, userId);
    if (job === null) throw new FinOpsBaseError('Solo se pueden archivar trabajos terminados.', 'VALIDATION_ERROR');
    await this.repository.createCloudAuditEvent({
      tenantId, actorUserId: userId, action: 'CLOUD_INGESTION_JOB_ARCHIVED', entityType: 'CLOUD_CONNECTION', entityId: job.cloudConnectionId,
      metadata: { jobId, status: job.status },
    });
    return job;
  }

  /**
   * Lista los controles de calidad de datos del tenant, del más reciente al más
   * antiguo. El `limit` se acota al rango [1, 200] con un valor por defecto de 50.
   */
  public listDataQualityChecks(
    tenantId: string,
    limit?: number,
  ): Promise<readonly DataQualityCheckItem[]> {
    return this.repository.listDataQualityChecksForTenant(tenantId, this.clampLimit(limit));
  }

  public getIngestionReadiness(tenantId: string): Promise<IngestionReadinessSummary> {
    return this.repository.listIngestionReadinessForTenant(tenantId);
  }

  private async requireConnection(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionSummary> {
    const connection = await this.repository.findCloudConnectionForTenant(tenantId, cloudConnectionId);
    if (connection === null) {
      throw new FinOpsBaseError('La conexión cloud no existe o no pertenece al tenant activo.', 'NOT_FOUND');
    }

    return connection;
  }

  private async queueIfUncovered(input: QueueIngestionInput): Promise<IngestionJobSummary | null> {
    const existing = await this.repository.listIngestionJobsForConnectionRange(input);
    const covered = existing.some((job) =>
      job.status !== 'FAILED'
      && job.status !== 'CANCELLED'
      && job.targetStart.getTime() <= input.targetStart.getTime()
      && job.targetEnd.getTime() >= input.targetEnd.getTime());

    return covered ? null : this.queueIngestion(input);
  }

  private resolveRangeDays(
    value: number | undefined,
    fallback: number,
    maximum: number,
    fieldName: string,
  ): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 1 || value > maximum) {
      throw new FinOpsBaseError(`El campo ${fieldName} debe estar entre 1 y ${maximum}.`, 'VALIDATION_ERROR');
    }

    return Math.floor(value);
  }

  /**
   * Normaliza y acota el límite de resultados al rango [1, 200]. Valores no
   * finitos o ausentes usan el valor por defecto (50); los decimales se truncan.
   */
  private clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return 50;
    }

    return Math.min(200, Math.max(1, Math.floor(limit)));
  }

}
