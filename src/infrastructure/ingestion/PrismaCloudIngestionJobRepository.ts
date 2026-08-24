import type {
  CloudIngestionConnection,
  CloudIngestionCredential,
  CloudIngestionJobContext,
  CloudIngestionResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { loadRuntimeConfig } from '../config/runtimeConfigReader.js';
import { CredentialCipher, type EncryptedCredentialPayload } from '../security/CredentialCipher.js';
import { upsertNormalizedCloudResources } from './PrismaCloudResourceCatalog.js';
import {
  buildMetricDerivedResources,
  mergeNormalizedResources,
} from './ingestionResourceNormalizer.js';
import { PrismaIngestionCostProjector } from './PrismaIngestionCostProjector.js';
import { PrismaIngestionJobCompletionSupport, type IngestionJobExecutionSummary } from './PrismaIngestionJobCompletionSupport.js';
import { mergeResourceLinkageStats } from './ingestionResourceLinkage.js';
import { PrismaIngestionSamplePersistence } from './PrismaIngestionSamplePersistence.js';
import { PrismaIngestionJobLifecycleRepository, type IngestionJobProgress } from './PrismaIngestionJobLifecycleRepository.js';
import { PrismaIngestionJobFailureHandler } from './PrismaIngestionJobFailureHandler.js';
import { mergeEnabledMetricDefinitions } from './ingestionMetricDefinitionMetadata.js';

interface ClaimedJobRow {
  readonly id: string;
}

type PrismaIngestionJobWithConnection = NonNullable<Awaited<ReturnType<PrismaCloudIngestionJobRepository['findJobContext']>>>;

export type { IngestionJobExecutionSummary } from './PrismaIngestionJobCompletionSupport.js';

export type { IngestionJobProgress } from './PrismaIngestionJobLifecycleRepository.js';

export class PrismaCloudIngestionJobRepository {
  private static readonly COMPLETION_TRANSACTION_OPTIONS = {
    maxWait: 10_000,
    timeout: 60_000,
  } as const;
  private readonly costProjector = new PrismaIngestionCostProjector();
  private readonly samplePersistence = new PrismaIngestionSamplePersistence();
  private readonly completionSupport = new PrismaIngestionJobCompletionSupport();
  private readonly lifecycle: PrismaIngestionJobLifecycleRepository;
  private readonly failureHandler: PrismaIngestionJobFailureHandler;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialCipher: CredentialCipher,
    private readonly jobLeaseMs = loadRuntimeConfig().workers.ingestion.jobLeaseMs,
    private readonly retryBackoffMs = loadRuntimeConfig().workers.ingestion.retryBackoffMs,
  ) {
    this.lifecycle = new PrismaIngestionJobLifecycleRepository(prisma);
    this.failureHandler = new PrismaIngestionJobFailureHandler(prisma, retryBackoffMs);
  }

  public async claimNextPendingJob(workerId: string): Promise<CloudIngestionJobContext | null> {
    const now = new Date();
    const leaseExpiredBefore = new Date(now.getTime() - this.jobLeaseMs);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE ingestion_jobs
        SET status = 'FAILED',
            completed_at = ${now},
            error_message = 'Ingestion job lease expired after exhausting retry attempts',
            locked_at = NULL,
            locked_by = NULL
        WHERE status = 'RUNNING'
          AND locked_at < ${leaseExpiredBefore}
          AND attempts >= max_attempts
      `;
      await tx.$executeRaw`
        UPDATE ingestion_jobs
        SET status = 'CANCELLED',
            completed_at = ${now},
            error_message = 'Cancelado mientras el trabajo estaba bloqueado.',
            locked_at = NULL,
            locked_by = NULL,
            progress = jsonb_build_object('phase', 'CANCELLED', 'message', 'Cancelado tras expirar el bloqueo.', 'updatedAt', CAST(${now.toISOString()} AS text))
        WHERE status = 'RUNNING'
          AND cancel_requested_at IS NOT NULL
          AND locked_at < ${leaseExpiredBefore}
      `;
      const rows = await tx.$queryRaw<ClaimedJobRow[]>`
        SELECT id
        FROM ingestion_jobs
        WHERE attempts < max_attempts
          AND available_at <= ${now}
          AND cancel_requested_at IS NULL
          AND archived_at IS NULL
          AND (
            status = 'PENDING'
            OR (status = 'RUNNING' AND locked_at < ${leaseExpiredBefore})
          )
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;

      const claimed = rows[0];
      if (claimed === undefined) {
        return null;
      }

      await tx.ingestionJob.update({
        where: { id: claimed.id },
        data: {
          status: 'RUNNING',
          attempts: { increment: 1 },
          lockedAt: now,
          lockedBy: workerId,
          startedAt: now,
          errorMessage: null,
          progress: { phase: 'DISCOVERING', message: 'Trabajo tomado por el worker.', updatedAt: now.toISOString() },
        },
      });

      const job = await this.findJobContext(claimed.id, tx);
      return job === null ? null : this.toJobContext(job);
    });
  }

  public async refreshJobLease(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    const updated = await this.prisma.ingestionJob.updateMany({
      where: { id: jobId, status: 'RUNNING', lockedBy: workerId, attempts: attempt },
      data: { lockedAt: new Date() },
    });
    return updated.count === 1;
  }

  public async updateJobProgress(
    jobId: string,
    workerId: string,
    attempt: number,
    progress: IngestionJobProgress,
  ): Promise<boolean> {
    return this.lifecycle.updateJobProgress(jobId, workerId, attempt, progress);
  }

  public async isCancellationRequested(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    return this.lifecycle.isCancellationRequested(jobId, workerId, attempt);
  }

  public async markCancelled(job: CloudIngestionJobContext, workerId: string, message = 'Cancelado por el usuario.'): Promise<boolean> {
    return this.lifecycle.markCancelled(job, workerId, message);
  }

  public async completeJob(
    job: CloudIngestionJobContext,
    result: CloudIngestionResult,
    startedAt: Date,
    workerId: string,
  ): Promise<IngestionJobExecutionSummary> {
    if (!await this.refreshJobLease(job.id, workerId, job.attempt)) {
      throw new Error('Ingestion job lease was lost before persistence');
    }
    const metricDerivedResources = buildMetricDerivedResources({
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      ...(job.connection.defaultRegion !== undefined ? { defaultRegion: job.connection.defaultRegion } : {}),
    }, result.metricSamples);
    const resources = mergeNormalizedResources([...result.resources, ...metricDerivedResources]);
    const resourceIdsByExternalId = await upsertNormalizedCloudResources(this.prisma, resources);
    let focusRowsProcessed = result.focusRows.length;
    let focusRowsInserted = await this.samplePersistence.insertFocusRows(this.prisma, result.focusRows);
    let costMetricProjection = await this.costProjector.projectFocusRowsToCostMetrics(this.prisma, job, result.focusRows, resourceIdsByExternalId);
    const providerProjection = await this.costProjector.projectProviderCostsToCostMetrics(this.prisma, job, result.providerCostRows ?? [], resourceIdsByExternalId);
    costMetricProjection = {
      projected: costMetricProjection.projected + providerProjection.projected,
      inserted: costMetricProjection.inserted + providerProjection.inserted,
      linkage: mergeResourceLinkageStats(costMetricProjection.linkage, providerProjection.linkage),
      historicalResourcesInserted: (costMetricProjection.historicalResourcesInserted ?? 0)
        + (providerProjection.historicalResourcesInserted ?? 0),
    };

    if (result.focusBatches !== undefined) {
      for await (const batch of result.focusBatches) {
        focusRowsProcessed += batch.length;
        focusRowsInserted += await this.samplePersistence.insertFocusRows(this.prisma, batch);
        const batchProjection = await this.costProjector.projectFocusRowsToCostMetrics(this.prisma, job, batch, resourceIdsByExternalId);
        costMetricProjection = {
          projected: costMetricProjection.projected + batchProjection.projected,
          inserted: costMetricProjection.inserted + batchProjection.inserted,
          linkage: mergeResourceLinkageStats(costMetricProjection.linkage, batchProjection.linkage),
          historicalResourcesInserted: (costMetricProjection.historicalResourcesInserted ?? 0)
            + (batchProjection.historicalResourcesInserted ?? 0),
        };
      }
    }

    const metricLinkage = await this.samplePersistence.insertMetricSamples(
      this.prisma,
      result.metricSamples,
      resourceIdsByExternalId,
    );
    await this.samplePersistence.reconcileMetricSampleResourceLinks(this.prisma, job.cloudConnectionId, resourceIdsByExternalId);
    await this.samplePersistence.refreshMetricStreamSummaries(
      this.prisma,
      job.cloudConnectionId,
      result.metricSamples,
    );

    const completedAt = new Date();
    const summary = this.completionSupport.buildSummary(
      job,
      result,
      completedAt.getTime() - startedAt.getTime(),
      costMetricProjection,
      focusRowsInserted,
      focusRowsProcessed,
      resources.length,
      metricDerivedResources.length,
      metricLinkage.linked,
      metricLinkage,
    );

    await this.prisma.$transaction(
      async (tx) => {
        const completed = await tx.ingestionJob.updateMany({
          where: { id: job.id, status: 'RUNNING', lockedBy: workerId, attempts: job.attempt },
          data: {
            status: summary.dataOutcome === 'INVALID_CONFIGURATION' ? 'SKIPPED' : 'SUCCESS',
            dataOutcome: summary.dataOutcome,
            completedAt,
            lockedAt: null,
            lockedBy: null,
            errorMessage: summary.dataOutcome === 'INVALID_CONFIGURATION'
              ? (summary.warnings[0] ?? 'La fuente no está configurada.')
              : null,
            progress: {
              phase: summary.dataOutcome === 'INVALID_CONFIGURATION' ? 'SKIPPED' : 'COMPLETED',
              message: summary.dataOutcome === 'INVALID_CONFIGURATION'
                ? 'Trabajo omitido: la fuente no está configurada.'
                : summary.dataOutcome === 'PARTIAL'
                  ? 'Ingesta completada parcialmente; revisa las advertencias.'
                  : summary.dataOutcome === 'NO_DATA'
                    ? 'Proveedor consultado correctamente, sin datos para el periodo.'
                    : 'Ingesta completada correctamente.',
              providerCalls: summary.apiCallCount,
              rowsRead: summary.focusRows,
              rowsWritten: summary.focusRowsInserted,
              resources: summary.resources,
              samples: summary.metricSamples,
              updatedAt: completedAt.toISOString(),
            } as unknown as Prisma.InputJsonValue,
            resultSummary: summary as unknown as Prisma.InputJsonValue,
          },
        });
        if (completed.count !== 1) {
          throw new Error('Ingestion job lease was lost before completion');
        }

        await this.completionSupport.updateWatermark(tx, job, summary.dataOutcome);
        await this.completionSupport.recordQualityCheck(
          tx,
          job,
          result,
          costMetricProjection,
          focusRowsInserted,
          focusRowsProcessed,
          resources.length,
          metricDerivedResources.length,
          metricLinkage.linked,
          metricLinkage,
        );

      },
      PrismaCloudIngestionJobRepository.COMPLETION_TRANSACTION_OPTIONS,
    );

    return summary;
  }

  public async failJob(
    job: CloudIngestionJobContext,
    error: unknown,
    startedAt: Date,
    workerId: string,
  ): Promise<void> {
    return this.failureHandler.failJob(job, error, startedAt, workerId);
  }

  private async findJobContext(
    jobId: string,
    client: Pick<PrismaClient, 'ingestionJob'> = this.prisma,
  ) {
    return client.ingestionJob.findUnique({
      where: { id: jobId },
      include: {
        cloudConnection: {
          include: {
            credentials: {
              where: {
                status: 'ACTIVE',
                purpose: { not: 'TEMPORARY_ADMIN' },
              },
            },
            metricDefinitions: {
              where: { enabled: true },
              select: {
                compartmentId: true,
                namespace: true,
                metricName: true,
                externalResourceId: true,
                regionId: true,
                dimensions: true,
                metricUnit: true,
                statistics: true,
              },
            },
          },
        },
      },
    });
  }

  private toJobContext(job: PrismaIngestionJobWithConnection): CloudIngestionJobContext {
    return {
      id: job.id,
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      sourceType: job.sourceType,
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
      attempt: job.attempts,
      ...(job.configurationHash !== null ? { configurationHash: job.configurationHash } : {}),
      ...(this.isJsonObject(job.requestContext) ? { requestContext: job.requestContext as Record<string, unknown> } : {}),
      connection: {
        id: job.cloudConnection.id,
        tenantId: job.cloudConnection.tenantId,
        providerCode: job.cloudConnection.providerCode,
        rootExternalId: job.cloudConnection.rootExternalId,
        ...(job.cloudConnection.defaultRegion !== null
          ? { defaultRegion: job.cloudConnection.defaultRegion }
          : {}),
        ...(() => {
          const metadata = mergeEnabledMetricDefinitions(
            job.cloudConnection.metadata,
            job.cloudConnection.metricDefinitions,
          );
          return metadata === undefined ? {} : { metadata };
        })(),
        credentials: job.cloudConnection.credentials.flatMap((credential): CloudIngestionCredential[] => {
          if (credential.purpose === 'TEMPORARY_ADMIN') {
            return [];
          }

          return [{
            purpose: credential.purpose,
            payload: this.credentialCipher.decrypt({
              encryptedPayload: credential.encryptedPayload,
              encryptionIv: credential.encryptionIv,
              encryptionAuthTag: credential.encryptionAuthTag,
              encryptionAlgorithm: 'aes-256-gcm',
              encryptionKeyVersion: credential.encryptionKeyVersion,
            } satisfies EncryptedCredentialPayload),
            ...(credential.externalPrincipalId !== null
              ? { externalPrincipalId: credential.externalPrincipalId }
              : {}),
          }];
        }),
      } satisfies CloudIngestionConnection,
    };
  }

  private isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
