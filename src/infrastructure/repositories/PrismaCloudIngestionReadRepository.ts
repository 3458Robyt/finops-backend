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
import { buildIngestionOperationalReadiness } from '../ingestion/ingestionOperationalReadiness.js';
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
        metricDefinitions: { where: { enabled: true }, select: { id: true } },
        credentials: { where: { status: 'ACTIVE' }, select: { purpose: true } },
        ingestionJobs: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, sourceType: true, status: true, targetStart: true, targetEnd: true, errorMessage: true, resultSummary: true, completedAt: true },
        },
      },
    });
    const successfulSources = await this.prisma.ingestionJob.groupBy({
      by: ['cloudConnectionId', 'sourceType'],
      where: {
        tenantId,
        status: 'SUCCESS',
      },
    });
    const successfulSourcesByConnection = new Map<string, string[]>();
    for (const row of successfulSources) {
      if (row.cloudConnectionId === null) continue;
      const sources = successfulSourcesByConnection.get(row.cloudConnectionId) ?? [];
      sources.push(row.sourceType);
      successfulSourcesByConnection.set(row.cloudConnectionId, sources);
    }

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
        configuredMetricDefinitionCount: connection.metricDefinitions.length,
        credentialPurposes: connection.credentials.map((credential) => credential.purpose),
        successfulSourceTypes: successfulSourcesByConnection.get(connection.id) ?? [],
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
    const [rows, worker] = await Promise.all([
      this.prisma.$queryRaw<readonly [{
        sourcePending: bigint;
        sourceRunning: bigint;
        projectionPending: bigint;
        projectionRunning: bigint;
        cancelRequested: bigint;
        staleSourceRunning: bigint;
        staleProjectionRunning: bigint;
        oldestPendingAt: Date | null;
      }]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS "sourcePending",
          COUNT(*) FILTER (WHERE status = 'RUNNING')::bigint AS "sourceRunning",
          COUNT(*) FILTER (WHERE status = 'SUCCESS' AND projection_status = 'PENDING')::bigint AS "projectionPending",
          COUNT(*) FILTER (WHERE status = 'SUCCESS' AND projection_status = 'RUNNING')::bigint AS "projectionRunning",
          COUNT(*) FILTER (WHERE status IN ('PENDING', 'RUNNING') AND cancel_requested_at IS NOT NULL)::bigint AS "cancelRequested",
          COUNT(*) FILTER (WHERE status = 'RUNNING' AND locked_at < ${staleBefore})::bigint AS "staleSourceRunning",
          COUNT(*) FILTER (WHERE status = 'SUCCESS' AND projection_status = 'RUNNING' AND projection_locked_at < ${staleBefore})::bigint AS "staleProjectionRunning",
          MIN(CASE
            WHEN status = 'PENDING' THEN created_at
            WHEN status = 'SUCCESS' AND projection_status = 'PENDING' THEN COALESCE(projection_available_at, created_at)
          END) AS "oldestPendingAt"
        FROM ingestion_jobs
        WHERE tenant_id = ${tenantId} AND archived_at IS NULL
      `,
      this.prisma.runtimeProcessHeartbeat.findFirst({
        where: { processRole: { in: ['all', 'worker', 'ingestion-worker'] }, status: 'RUNNING', lastHeartbeatAt: { gte: staleBefore } },
        orderBy: { lastHeartbeatAt: 'desc' },
        select: { processId: true, processRole: true, lastHeartbeatAt: true },
      }),
    ]);
    const counts = rows[0];
    return buildIngestionOperationalReadiness({
      sourcePending: Number(counts?.sourcePending ?? 0n),
      sourceRunning: Number(counts?.sourceRunning ?? 0n),
      projectionPending: Number(counts?.projectionPending ?? 0n),
      projectionRunning: Number(counts?.projectionRunning ?? 0n),
      cancelRequested: Number(counts?.cancelRequested ?? 0n),
      staleSourceRunning: Number(counts?.staleSourceRunning ?? 0n),
      staleProjectionRunning: Number(counts?.staleProjectionRunning ?? 0n),
      oldestPendingAt: counts?.oldestPendingAt ?? null,
      worker: worker === null ? null : {
        processId: worker.processId,
        processRole: worker.processRole,
        lastHeartbeatAt: worker.lastHeartbeatAt,
      },
    });
  }

  private async countJobs(
    tenantId: string,
    cloudConnectionId: string,
    status: 'PENDING' | 'RUNNING' | 'FAILED',
  ): Promise<number> {
    return this.prisma.ingestionJob.count({ where: { tenantId, cloudConnectionId, status } });
  }
}
