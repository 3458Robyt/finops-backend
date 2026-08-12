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

interface ClaimedJobRow {
  readonly id: string;
}

type PrismaIngestionJobWithConnection = NonNullable<Awaited<ReturnType<PrismaCloudIngestionJobRepository['findJobContext']>>>;

export type { IngestionJobExecutionSummary } from './PrismaIngestionJobCompletionSupport.js';

export class PrismaCloudIngestionJobRepository {
  private static readonly COMPLETION_TRANSACTION_OPTIONS = {
    maxWait: 10_000,
    timeout: 60_000,
  } as const;
  private readonly costProjector = new PrismaIngestionCostProjector();
  private readonly samplePersistence = new PrismaIngestionSamplePersistence();
  private readonly completionSupport = new PrismaIngestionJobCompletionSupport();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialCipher: CredentialCipher,
    private readonly jobLeaseMs = loadRuntimeConfig().workers.ingestion.jobLeaseMs,
  ) {}

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
      const rows = await tx.$queryRaw<ClaimedJobRow[]>`
        SELECT id
        FROM ingestion_jobs
        WHERE attempts < max_attempts
          AND (
            status = 'PENDING'
            OR (status = 'RUNNING' AND locked_at < ${leaseExpiredBefore})
          )
        ORDER BY created_at ASC
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
            status: 'SUCCESS',
            completedAt,
            lockedAt: null,
            lockedBy: null,
            errorMessage: null,
            resultSummary: summary as unknown as Prisma.InputJsonValue,
          },
        });
        if (completed.count !== 1) {
          throw new Error('Ingestion job lease was lost before completion');
        }

        await this.completionSupport.updateWatermark(tx, job);
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
    const completedAt = new Date();
    const message = error instanceof Error ? error.message : 'Unknown ingestion worker error';
    const current = await this.prisma.ingestionJob.findFirst({
      where: { id: job.id, status: 'RUNNING', lockedBy: workerId, attempts: job.attempt },
      select: { attempts: true, maxAttempts: true },
    });
    const shouldRetry = current !== null && current.attempts < current.maxAttempts;

    const failed = await this.prisma.ingestionJob.updateMany({
      where: { id: job.id, status: 'RUNNING', lockedBy: workerId, attempts: job.attempt },
      data: {
        status: shouldRetry ? 'PENDING' : 'FAILED',
        completedAt,
        lockedAt: null,
        lockedBy: null,
        errorMessage: message,
        resultSummary: {
          durationMs: completedAt.getTime() - startedAt.getTime(),
          providerCode: job.connection.providerCode,
          sourceType: job.sourceType,
          error: message,
          retryScheduled: shouldRetry,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (failed.count !== 1) {
      return;
    }

    await this.prisma.dataQualityCheck.create({
      data: {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        sourceType: job.sourceType,
        checkName: 'ingestion_job_execution',
        status: shouldRetry ? 'WARNING' : 'FAILED',
        expectedAt: job.targetEnd,
        details: {
          jobId: job.id,
          error: message,
          retryScheduled: shouldRetry,
        } as unknown as Prisma.InputJsonValue,
      },
    });
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
                purpose: {
                  not: 'TEMPORARY_ADMIN',
                },
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
      connection: {
        id: job.cloudConnection.id,
        tenantId: job.cloudConnection.tenantId,
        providerCode: job.cloudConnection.providerCode,
        rootExternalId: job.cloudConnection.rootExternalId,
        ...(job.cloudConnection.defaultRegion !== null
          ? { defaultRegion: job.cloudConnection.defaultRegion }
          : {}),
        ...(this.isJsonObject(job.cloudConnection.metadata)
          ? { metadata: job.cloudConnection.metadata as Record<string, unknown> }
          : {}),
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
