import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { FocusCostMetricProjectionResult } from './PrismaIngestionCostProjector.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';
import type { ResourceLinkageRunStats } from './ingestionResourceLinkage.js';

export interface IngestionJobExecutionSummary {
  readonly durationMs: number;
  readonly providerCode: string;
  readonly sourceType: IngestionSourceType;
  readonly apiCallCount: number;
  readonly objectsProcessed: number;
  readonly focusRows: number;
  readonly focusRowsInserted: number;
  readonly costMetrics: number;
  readonly costMetricsInserted: number;
  readonly resources: number;
  readonly metricDerivedResources: number;
  readonly metricSamples: number;
  readonly metricSamplesLinkedToResource: number;
  readonly resourceLinkage: {
    readonly costs: ResourceLinkageRunStats;
    readonly metrics: ResourceLinkageRunStats;
  };
  readonly warnings: readonly string[];
  readonly coverage: Readonly<Record<string, unknown>>;
}

/** Persists completion metadata and builds the stable ingestion result summary. */
export class PrismaIngestionJobCompletionSupport {
  public async updateWatermark(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
  ): Promise<void> {
    await tx.ingestionWatermark.upsert({
      where: {
        cloudConnectionId_sourceType: {
          cloudConnectionId: job.cloudConnectionId,
          sourceType: job.sourceType,
        },
      },
      update: {
        watermarkStart: job.targetStart,
        watermarkEnd: job.targetEnd,
        lastSuccessfulRunAt: new Date(),
        freshnessDeadlineAt: this.calculateFreshnessDeadline(job),
      },
      create: {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        sourceType: job.sourceType,
        watermarkStart: job.targetStart,
        watermarkEnd: job.targetEnd,
        lastSuccessfulRunAt: new Date(),
        freshnessDeadlineAt: this.calculateFreshnessDeadline(job),
      },
    });
  }

  public async recordQualityCheck(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    result: CloudIngestionResult,
    costMetricProjection: FocusCostMetricProjectionResult,
    focusRowsInserted: number,
    focusRowsProcessed: number,
    resourcesPersisted: number,
    metricDerivedResources: number,
    metricSamplesLinkedToResource: number,
    metricLinkage: ResourceLinkageRunStats,
  ): Promise<void> {
    await tx.dataQualityCheck.create({
      data: {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        sourceType: job.sourceType,
        checkName: 'ingestion_job_execution',
        status: result.warnings.length === 0 ? 'PASSED' : 'WARNING',
        expectedAt: job.targetEnd,
        details: {
          jobId: job.id,
          apiCallCount: result.apiCallCount,
          objectsProcessed: result.objectsProcessed,
          focusRows: focusRowsProcessed,
          focusRowsInserted,
          costMetrics: costMetricProjection.projected,
          costMetricsInserted: costMetricProjection.inserted,
          historicalResourcesInserted: costMetricProjection.historicalResourcesInserted ?? 0,
          resources: resourcesPersisted,
          metricDerivedResources,
          metricSamples: result.metricSamples.length,
          metricSamplesLinkedToResource,
          resourceLinkage: { costs: costMetricProjection.linkage, metrics: metricLinkage },
          warnings: result.warnings,
          coverage: result.coverage,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  public buildSummary(
    job: CloudIngestionJobContext,
    result: CloudIngestionResult,
    durationMs: number,
    costMetricProjection: FocusCostMetricProjectionResult,
    focusRowsInserted: number,
    focusRowsProcessed: number,
    resourcesPersisted: number,
    metricDerivedResources: number,
    metricSamplesLinkedToResource: number,
    metricLinkage: ResourceLinkageRunStats,
  ): IngestionJobExecutionSummary {
    return {
      durationMs,
      providerCode: job.connection.providerCode,
      sourceType: job.sourceType,
      apiCallCount: result.apiCallCount,
      objectsProcessed: result.objectsProcessed,
      focusRows: focusRowsProcessed,
      focusRowsInserted,
      costMetrics: costMetricProjection.projected,
      costMetricsInserted: costMetricProjection.inserted,
      resources: resourcesPersisted,
      metricDerivedResources,
      metricSamples: result.metricSamples.length,
      metricSamplesLinkedToResource,
      resourceLinkage: { costs: costMetricProjection.linkage, metrics: metricLinkage },
      warnings: result.warnings,
      coverage: {
        ...result.coverage,
        historicalResourcesInserted: costMetricProjection.historicalResourcesInserted ?? 0,
      },
    };
  }

  private calculateFreshnessDeadline(job: CloudIngestionJobContext): Date {
    const hours = job.sourceType === 'BILLING_EXPORT' ? 30 : 1;
    return new Date(job.targetEnd.getTime() + hours * 60 * 60 * 1000);
  }
}
