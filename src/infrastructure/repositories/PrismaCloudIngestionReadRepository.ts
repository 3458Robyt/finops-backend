import type {
  DataQualityCheckItem,
  IngestionJobHistoryItem,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
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

/** Encapsulates ingestion health, history, readiness, and job operations. */
export class PrismaCloudIngestionReadRepository {
  constructor(private readonly prisma: PrismaClient) {}

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

    return buildIngestionReadinessSummary({
      generatedAt: new Date(),
      missingProviderMessageSuffix: ' for this tenant',
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

  private async countJobs(
    tenantId: string,
    cloudConnectionId: string,
    status: 'PENDING' | 'RUNNING' | 'FAILED',
  ): Promise<number> {
    return this.prisma.ingestionJob.count({ where: { tenantId, cloudConnectionId, status } });
  }
}
