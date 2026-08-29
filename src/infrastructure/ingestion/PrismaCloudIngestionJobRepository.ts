import type { CloudIngestionJobContext, CloudIngestionResult } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { loadRuntimeConfig } from '../config/runtimeConfigReader.js';
import { CredentialCipher } from '../security/CredentialCipher.js';
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
import { PrismaIngestionJobSupport } from './PrismaIngestionJobSupport.js';
import { PrismaIngestionJobClaimRepository } from './PrismaIngestionJobClaimRepository.js';
import type { IngestionJobReconciliationResult } from './PrismaIngestionJobLeaseReconciler.js';
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
  private readonly support: PrismaIngestionJobSupport;
  private readonly claimRepository: PrismaIngestionJobClaimRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialCipher: CredentialCipher,
    private readonly jobLeaseMs = loadRuntimeConfig().workers.ingestion.jobLeaseMs,
    private readonly retryBackoffMs = loadRuntimeConfig().workers.ingestion.retryBackoffMs,
  ) {
    this.lifecycle = new PrismaIngestionJobLifecycleRepository(prisma);
    this.failureHandler = new PrismaIngestionJobFailureHandler(prisma, retryBackoffMs);
    this.support = new PrismaIngestionJobSupport(prisma, credentialCipher);
    this.claimRepository = new PrismaIngestionJobClaimRepository(prisma, this.support, jobLeaseMs);
  }
  public async claimNextPendingJob(workerId: string): Promise<CloudIngestionJobContext | null> {
    return this.claimRepository.claimNextPendingJob(workerId);
  }
  public async reconcileStaleJobs(now = new Date()): Promise<IngestionJobReconciliationResult> {
    return this.claimRepository.reconcileStaleJobs(now);
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
    onProgress?: (progress: IngestionJobProgress) => Promise<void>,
    shouldCancel?: () => Promise<boolean>,
  ): Promise<IngestionJobExecutionSummary> {
    if (!await this.refreshJobLease(job.id, workerId, job.attempt)) {
      throw new Error('Ingestion job lease was lost before persistence');
    }
    const initialMetricDerivedResources = buildMetricDerivedResources({
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      ...(job.connection.defaultRegion !== undefined ? { defaultRegion: job.connection.defaultRegion } : {}),
    }, result.metricSamples);
    const resources = mergeNormalizedResources([...result.resources, ...initialMetricDerivedResources]);
    const resourceIdsByExternalId = new Map(await upsertNormalizedCloudResources(this.prisma, resources));
    await this.support.registerSourceObjects(job, result.sourceObjects);
    const metricDerivedResourceKeys = new Set(initialMetricDerivedResources.map((resource) => `${resource.cloudConnectionId}:${resource.externalResourceId}`));
    let metricDerivedResources = initialMetricDerivedResources.length;
    let metricSamplesProcessed = 0;
    let metricSamplesInserted = 0;
    let metricSamplesLinked = 0;
    let metricLinkage = mergeResourceLinkageStats(
      { linked: 0, unresolved: 0, reasons: {} },
      { linked: 0, unresolved: 0, reasons: {} },
    );
    let metricBatchSequence = 0;
    const assertNotCancelled = async (): Promise<void> => {
      if (shouldCancel !== undefined && await shouldCancel()) {
        throw new Error('Ingestion job cancellation requested during persistence');
      }
    };
    const persistMetricBatch = async (batch: readonly CloudIngestionResult['metricSamples'][number][]): Promise<void> => {
      if (batch.length === 0) return;
      await assertNotCancelled();
      const partKey = `TECHNICAL_METRIC:${metricBatchSequence}`;
      await this.support.updateJobPart(job, partKey, {
        status: 'RUNNING',
        samplesRead: batch.length,
        startedAt: new Date(),
      });
      try {
        const derived = buildMetricDerivedResources({
          tenantId: job.tenantId,
          cloudConnectionId: job.cloudConnectionId,
          ...(job.connection.defaultRegion !== undefined ? { defaultRegion: job.connection.defaultRegion } : {}),
        }, batch);
        if (derived.length > 0) {
          const persisted = await upsertNormalizedCloudResources(this.prisma, derived);
          for (const [externalResourceId, resourceId] of persisted) resourceIdsByExternalId.set(externalResourceId, resourceId);
          for (const resource of derived) {
            const key = `${resource.cloudConnectionId}:${resource.externalResourceId}`;
            if (!metricDerivedResourceKeys.has(key)) {
              metricDerivedResourceKeys.add(key);
              metricDerivedResources += 1;
            }
          }
        }
        const linkage = await this.samplePersistence.insertMetricSamples(
          this.prisma,
          batch,
          resourceIdsByExternalId,
          job.id,
        );
        metricLinkage = mergeResourceLinkageStats(metricLinkage, linkage);
        metricSamplesProcessed += batch.length;
        metricSamplesInserted += linkage.inserted;
        metricSamplesLinked += linkage.linked;
        if (onProgress !== undefined) {
          await onProgress({
            phase: 'PERSISTING_RAW',
            message: `Persistiendo lote técnico ${metricBatchSequence + 1}.`,
            providerCalls: result.apiCallCount,
            rowsRead: result.focusRows.length,
            resources: resources.length + metricDerivedResources,
            samples: metricSamplesProcessed,
            updatedAt: new Date().toISOString(),
          });
        }
        await this.support.updateJobPart(job, partKey, {
          status: 'SUCCESS',
          samplesRead: batch.length,
          samplesWritten: batch.length,
          completedAt: new Date(),
        });
      } catch (error) {
        await this.support.updateJobPart(job, partKey, {
          status: 'FAILED',
          samplesRead: batch.length,
          completedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        throw error;
      }
      metricBatchSequence += 1;
    };

    await persistMetricBatch(result.metricSamples);
    await assertNotCancelled();
    let focusRowsProcessed = result.focusRows.length;
    let focusRowsInserted = await this.samplePersistence.insertFocusRows(this.prisma, result.focusRows, job.id);
    let costMetricProjection = await this.costProjector.projectFocusRowsToCostMetrics(this.prisma, job, result.focusRows, resourceIdsByExternalId);
    const providerProjection = await this.costProjector.projectProviderCostsToCostMetrics(this.prisma, job, result.providerCostRows ?? [], resourceIdsByExternalId);
    costMetricProjection = {
      projected: costMetricProjection.projected + providerProjection.projected,
      inserted: costMetricProjection.inserted + providerProjection.inserted,
      linkage: mergeResourceLinkageStats(costMetricProjection.linkage, providerProjection.linkage),
      historicalResourcesInserted: (costMetricProjection.historicalResourcesInserted ?? 0)
        + (providerProjection.historicalResourcesInserted ?? 0),
    };

    let focusBatchSequence = 0;
    if (result.focusBatches !== undefined) {
      for await (const batch of result.focusBatches) {
        await assertNotCancelled();
        const partKey = `BILLING_EXPORT:${focusBatchSequence}`;
        await this.support.updateJobPart(job, partKey, {
          status: 'RUNNING',
          rowsRead: batch.length,
          startedAt: new Date(),
        });
        try {
          focusRowsProcessed += batch.length;
          focusRowsInserted += await this.samplePersistence.insertFocusRows(this.prisma, batch, job.id);
          const batchProjection = await this.costProjector.projectFocusRowsToCostMetrics(this.prisma, job, batch, resourceIdsByExternalId);
          costMetricProjection = {
            projected: costMetricProjection.projected + batchProjection.projected,
            inserted: costMetricProjection.inserted + batchProjection.inserted,
            linkage: mergeResourceLinkageStats(costMetricProjection.linkage, batchProjection.linkage),
            historicalResourcesInserted: (costMetricProjection.historicalResourcesInserted ?? 0)
              + (batchProjection.historicalResourcesInserted ?? 0),
          };
          if (onProgress !== undefined) {
            await onProgress({
              phase: 'PERSISTING_RAW',
              message: 'Persistiendo lote FOCUS.',
              providerCalls: result.apiCallCount,
              rowsRead: focusRowsProcessed,
              rowsWritten: focusRowsInserted,
              resources: resources.length + metricDerivedResources,
              samples: metricSamplesProcessed,
              updatedAt: new Date().toISOString(),
            });
          }
          await this.support.updateJobPart(job, partKey, {
            status: 'SUCCESS',
            rowsRead: batch.length,
            rowsWritten: batch.length,
            completedAt: new Date(),
          });
        } catch (error) {
          await this.support.updateJobPart(job, partKey, {
            status: 'FAILED',
            rowsRead: batch.length,
            completedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
          throw error;
        }
        focusBatchSequence += 1;
      }
    }

    if (result.metricBatches !== undefined) {
      for await (const batch of result.metricBatches) {
        await persistMetricBatch(batch);
      }
    }
    await assertNotCancelled();
    await this.support.completeSourceObjects(job, result.sourceObjects, focusRowsProcessed);

    const completedAt = new Date();
    const summary = this.completionSupport.buildSummary(
      job,
      result,
      completedAt.getTime() - startedAt.getTime(),
      costMetricProjection,
      focusRowsInserted,
      focusRowsProcessed,
      resources.length,
      metricDerivedResources,
      metricSamplesLinked,
      metricSamplesProcessed,
      metricSamplesInserted,
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
            projectionStatus: summary.projectionStatus,
            projectionAttempts: 0,
            projectionAvailableAt: summary.projectionStatus === 'PENDING' ? completedAt : null,
            projectionLockedAt: null,
            projectionLockedBy: null,
            projectionStartedAt: null,
            projectionCompletedAt: null,
            projectionErrorMessage: null,
            errorMessage: summary.dataOutcome === 'INVALID_CONFIGURATION'
              ? (summary.warnings[0] ?? 'La fuente no está configurada.')
              : null,
            progress: {
              phase: summary.dataOutcome === 'INVALID_CONFIGURATION'
                ? 'SKIPPED'
                : summary.projectionStatus === 'PENDING' ? 'RAW_COMPLETE' : 'COMPLETED',
              message: summary.dataOutcome === 'INVALID_CONFIGURATION'
                ? 'Trabajo omitido: la fuente no está configurada.'
                : summary.projectionStatus === 'PENDING'
                  ? 'Datos raw persistidos; proyección técnica en cola.'
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
        await this.completionSupport.recordCoverageSegment(tx, job, summary);
        await this.completionSupport.recordQualityCheck(
          tx,
          job,
          result,
          costMetricProjection,
          focusRowsInserted,
          focusRowsProcessed,
          resources.length,
          metricDerivedResources,
          metricSamplesLinked,
          metricSamplesProcessed,
          metricSamplesInserted,
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
}
