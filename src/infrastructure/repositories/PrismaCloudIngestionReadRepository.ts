import type {
  DataQualityCheckItem,
  IngestionJobHistoryItem,
  IngestionMetricCoverageQuery,
  IngestionMetricCoverageResult,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
  IngestionOperationalReadiness,
  IngestionReadinessSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type { DataQualityStatus, IngestionHealthSummary, IngestionSourceType } from '../../domain/models/CloudConnection.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  isJsonObject,
  mapCloudConnection,
  mapProvider,
  toDataQualityCheckItem,
  toIngestionJobHistoryItem,
} from './mappers/cloudConnectionMappers.js';
import { buildIngestionReadinessSummary } from '../ingestion/ingestionReadiness.js';
import { PrismaMetricCoverageReadRepository } from './PrismaMetricCoverageReadRepository.js';

/** Encapsulates ingestion health, history, readiness, and job operations. */
export class PrismaCloudIngestionReadRepository {
  private readonly metricCoverageRepository: PrismaMetricCoverageReadRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.metricCoverageRepository = new PrismaMetricCoverageReadRepository(prisma);
  }

  public async getIngestionHealth(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<IngestionHealthSummary | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId },
      include: {
        providerCatalog: true,
        ingestionWatermarks: true,
        dataQualityChecks: { orderBy: { observedAt: 'desc' }, take: 20 },
      },
    });
    if (connection === null) return null;

    const [pending, running, failed] = await Promise.all([
      this.countJobs(tenantId, cloudConnectionId, 'PENDING'),
      this.countJobs(tenantId, cloudConnectionId, 'RUNNING'),
      this.countJobs(tenantId, cloudConnectionId, 'FAILED'),
    ]);

    return {
      cloudConnection: mapCloudConnection(connection),
      provider: mapProvider(connection.providerCatalog),
      jobs: { pending, running, failed },
      watermarks: connection.ingestionWatermarks.map((watermark) => ({
        sourceType: watermark.sourceType as IngestionSourceType,
        ...(watermark.watermarkStart !== null ? { watermarkStart: watermark.watermarkStart } : {}),
        ...(watermark.watermarkEnd !== null ? { watermarkEnd: watermark.watermarkEnd } : {}),
        ...(watermark.lastSuccessfulRunAt !== null ? { lastSuccessfulRunAt: watermark.lastSuccessfulRunAt } : {}),
        ...(watermark.freshnessDeadlineAt !== null ? { freshnessDeadlineAt: watermark.freshnessDeadlineAt } : {}),
      })),
      qualityChecks: connection.dataQualityChecks.map((check) => ({
        sourceType: check.sourceType as IngestionSourceType,
        checkName: check.checkName,
        status: check.status as DataQualityStatus,
        observedAt: check.observedAt,
        ...(check.expectedAt !== null ? { expectedAt: check.expectedAt } : {}),
        ...(isJsonObject(check.details) ? { details: check.details as Record<string, unknown> } : {}),
      })),
    };
  }

  public async listIngestionJobsForTenant(
    tenantId: string,
    limit: number,
    includeArchived = false,
  ): Promise<readonly IngestionJobHistoryItem[]> {
    const jobs = await this.prisma.ingestionJob.findMany({
      where: { tenantId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return jobs.map((job) => toIngestionJobHistoryItem(job));
  }

  public async getIngestionJobForTenant(tenantId: string, jobId: string): Promise<IngestionJobHistoryItem | null> {
    const job = await this.prisma.ingestionJob.findFirst({ where: { id: jobId, tenantId } });
    return job === null ? null : toIngestionJobHistoryItem(job);
  }

  public async requestIngestionJobCancellation(
    tenantId: string,
    jobId: string,
    userId: string,
  ): Promise<IngestionJobHistoryItem | null> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const pending = await tx.ingestionJob.updateMany({
        where: { id: jobId, tenantId, status: 'PENDING', archivedAt: null },
        data: {
          status: 'CANCELLED',
          completedAt: now,
          cancelRequestedAt: now,
          cancelRequestedByUserId: userId,
          errorMessage: 'Cancelado por el usuario.',
          progress: { phase: 'CANCELLED', message: 'Trabajo cancelado antes de iniciar.', updatedAt: now.toISOString() },
        },
      });
      if (pending.count === 1) return;
      await tx.ingestionJob.updateMany({
        where: { id: jobId, tenantId, status: 'RUNNING', archivedAt: null },
        data: {
          cancelRequestedAt: now,
          cancelRequestedByUserId: userId,
          progress: { phase: 'CANCELLATION_REQUESTED', message: 'Cancelación solicitada; se detendrá al finalizar la fase actual.', updatedAt: now.toISOString() },
        },
      });
    });
    return this.getIngestionJobForTenant(tenantId, jobId);
  }

  public async archiveIngestionJob(
    tenantId: string,
    jobId: string,
    userId: string,
  ): Promise<IngestionJobHistoryItem | null> {
    await this.prisma.ingestionJob.updateMany({
      where: {
        id: jobId,
        tenantId,
        archivedAt: null,
        status: { in: ['SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED'] },
      },
      data: { archivedAt: new Date(), archivedByUserId: userId },
    });
    return this.getIngestionJobForTenant(tenantId, jobId);
  }

  public async listDataQualityChecksForTenant(tenantId: string, limit: number): Promise<readonly DataQualityCheckItem[]> {
    const checks = await this.prisma.dataQualityCheck.findMany({
      where: { tenantId },
      orderBy: { observedAt: 'desc' },
      take: limit,
    });
    return checks.map((check) => toDataQualityCheckItem(check));
  }

  public async listIngestionJobsForConnectionRange(
    input: IngestionJobRangeQuery,
  ): Promise<readonly IngestionJobWindowItem[]> {
    const jobs = await this.prisma.ingestionJob.findMany({
      where: {
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: input.sourceType,
        ...(input.configurationHash !== undefined ? { configurationHash: input.configurationHash } : {}),
        status: { in: ['PENDING', 'RUNNING', 'SUCCESS'] },
        targetStart: { lt: input.targetEnd },
        targetEnd: { gt: input.targetStart },
      },
      orderBy: { targetStart: 'asc' },
      select: { id: true, sourceType: true, status: true, dataOutcome: true, targetStart: true, targetEnd: true, configurationHash: true },
    });
    return jobs.map((job) => ({
      id: job.id,
      sourceType: job.sourceType,
      status: job.status,
      ...(job.dataOutcome !== null ? { dataOutcome: job.dataOutcome } : {}),
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
      ...(job.configurationHash !== null ? { configurationHash: job.configurationHash } : {}),
    }));
  }

  public async listFailedIngestionJobsForConnection(
    tenantId: string,
    cloudConnectionId: string,
    sourceType?: IngestionSourceType,
  ): Promise<readonly IngestionJobWindowItem[]> {
    const jobs = await this.prisma.ingestionJob.findMany({
      where: {
        tenantId,
        cloudConnectionId,
        status: 'FAILED',
        ...(sourceType !== undefined ? { sourceType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, sourceType: true, status: true, dataOutcome: true, targetStart: true, targetEnd: true },
    });
    return jobs.map((job) => ({
      id: job.id,
      sourceType: job.sourceType,
      status: job.status,
      ...(job.dataOutcome !== null ? { dataOutcome: job.dataOutcome } : {}),
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
    }));
  }

  public async cancelPendingIngestionJobs(
    tenantId: string,
    cloudConnectionId: string,
    sourceType: IngestionSourceType,
  ): Promise<number> {
    const result = await this.prisma.ingestionJob.updateMany({
      where: { tenantId, cloudConnectionId, sourceType, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date(), errorMessage: 'Cancelado por el usuario.' },
    });
    return result.count;
  }

  public async listIngestionReadinessForTenant(tenantId: string): Promise<IngestionReadinessSummary> {
    const connections = await this.prisma.cloudConnection.findMany({
      where: { tenantId, providerCode: { in: ['aws', 'oci'] }, status: 'ACTIVE' },
      orderBy: [{ providerCode: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        providerCode: true,
        defaultRegion: true,
        lastValidatedAt: true,
        lastValidationAttemptAt: true,
        metadata: true,
        credentials: { where: { status: 'ACTIVE' }, select: { purpose: true } },
        ingestionJobs: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, sourceType: true, status: true, targetStart: true, targetEnd: true, errorMessage: true, resultSummary: true, completedAt: true },
        },
      },
    });

    const operational = await this.readOperationalReadiness(tenantId);
    const globalIssues = operational.queue.pending > 0 && !operational.worker.available
      ? [{
        provider: 'global' as const,
        severity: 'BLOCKER' as const,
        capability: 'JOBS' as const,
        message: 'Hay trabajos en cola, pero no hay un worker de ingesta activo.',
        affectedData: ['Trabajos de ingesta pendientes'],
        action: 'Inicia el backend con el worker de ingesta habilitado.',
        actionCode: 'RETRY_FAILED_JOBS' as const,
      }]
      : [];
    return buildIngestionReadinessSummary({
      generatedAt: new Date(),
      missingProviderMessageSuffix: ' for this tenant',
      globalIssues,
      operational,
      connections: connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        providerCode: connection.providerCode,
        defaultRegion: connection.defaultRegion,
        lastValidatedAt: connection.lastValidatedAt,
        lastValidationAttemptAt: connection.lastValidationAttemptAt,
        metadata: connection.metadata,
        credentialPurposes: connection.credentials.map((credential) => credential.purpose),
        recentJobs: connection.ingestionJobs.map((job) => ({
          id: job.id,
          sourceType: job.sourceType,
          status: job.status,
          targetStart: job.targetStart,
          targetEnd: job.targetEnd,
          completedAt: job.completedAt,
          errorMessage: job.errorMessage,
          resultSummary: job.resultSummary,
        })),
      })),
    });
  }

  public async listMetricCoverageForTenant(
    input: IngestionMetricCoverageQuery,
  ): Promise<IngestionMetricCoverageResult> {
    return this.metricCoverageRepository.listMetricCoverageForTenant(input);
  }

  private async readOperationalReadiness(tenantId: string): Promise<IngestionOperationalReadiness> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 90_000);
    const [counts, oldestPending, worker] = await Promise.all([
      this.prisma.$queryRaw<readonly { status: string; count: bigint }[]>`
        SELECT status::text AS status, COUNT(*)::bigint AS count
        FROM ingestion_jobs
        WHERE tenant_id = ${tenantId} AND archived_at IS NULL
        GROUP BY status
      `,
      this.prisma.ingestionJob.findFirst({
        where: { tenantId, status: 'PENDING', archivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.runtimeProcessHeartbeat.findFirst({
        where: { processRole: { in: ['all', 'ingestion-worker'] }, status: 'RUNNING', lastHeartbeatAt: { gte: staleBefore } },
        orderBy: { lastHeartbeatAt: 'desc' },
        select: { processId: true, processRole: true, lastHeartbeatAt: true },
      }),
    ]);
    const countByStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));
    const pending = countByStatus.get('PENDING') ?? 0;
    const running = countByStatus.get('RUNNING') ?? 0;
    const cancelRequested = await this.prisma.ingestionJob.count({
      where: { tenantId, archivedAt: null, cancelRequestedAt: { not: null }, status: { in: ['PENDING', 'RUNNING'] } },
    });
    const staleRunning = await this.prisma.ingestionJob.count({
      where: { tenantId, archivedAt: null, status: 'RUNNING', lockedAt: { lt: staleBefore } },
    });
    const state = staleRunning > 0
      ? 'STALE'
      : cancelRequested > 0
        ? 'CANCEL_REQUESTED'
        : !worker && pending > 0
          ? 'WAITING_FOR_WORKER'
          : running > 0
            ? 'RUNNING'
            : pending > 0 ? 'QUEUED' : 'IDLE';
    return {
      state,
      queue: { pending, running, cancelRequested, staleRunning },
      ...(oldestPending === null ? {} : { oldestPendingAt: oldestPending.createdAt }),
      worker: {
        available: worker !== null,
        ...(worker === null ? {} : { processId: worker.processId, processRole: worker.processRole, lastHeartbeatAt: worker.lastHeartbeatAt }),
      },
    };
  }

  private async countJobs(
    tenantId: string,
    cloudConnectionId: string,
    status: 'PENDING' | 'RUNNING' | 'FAILED',
  ): Promise<number> {
    return this.prisma.ingestionJob.count({ where: { tenantId, cloudConnectionId, status } });
  }
}
