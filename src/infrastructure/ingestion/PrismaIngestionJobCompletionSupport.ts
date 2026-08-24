import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { IngestionDataOutcome, IngestionSourceType } from '../../domain/models/CloudConnection.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { FocusCostMetricProjectionResult } from './PrismaIngestionCostProjector.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';
import type { ResourceLinkageRunStats } from './ingestionResourceLinkage.js';

export interface IngestionJobExecutionSummary {
  readonly durationMs: number;
  readonly providerCode: string;
  readonly sourceType: IngestionSourceType;
  readonly dataOutcome: IngestionDataOutcome;
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
    dataOutcome: IngestionDataOutcome,
  ): Promise<void> {
    if (dataOutcome !== 'DATA_WRITTEN' && dataOutcome !== 'NO_DATA') return;
    const scopeKey = this.resolveScopeKey(job);
    await tx.ingestionWatermark.upsert({
      where: {
        cloudConnectionId_sourceType_scopeKey: {
          cloudConnectionId: job.cloudConnectionId,
          sourceType: job.sourceType,
          scopeKey,
        },
      },
      update: {
        watermarkStart: job.targetStart,
        watermarkEnd: job.targetEnd,
        lastSuccessfulRunAt: new Date(),
        ...(dataOutcome === 'DATA_WRITTEN' ? { lastDataAt: new Date() } : {}),
        ...(job.configurationHash !== undefined ? { configurationHash: job.configurationHash } : {}),
        freshnessDeadlineAt: this.calculateFreshnessDeadline(job),
      },
      create: {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        sourceType: job.sourceType,
        scopeKey,
        ...(job.configurationHash !== undefined ? { configurationHash: job.configurationHash } : {}),
        watermarkStart: job.targetStart,
        watermarkEnd: job.targetEnd,
        lastSuccessfulRunAt: new Date(),
        ...(dataOutcome === 'DATA_WRITTEN' ? { lastDataAt: new Date() } : {}),
        freshnessDeadlineAt: this.calculateFreshnessDeadline(job),
      },
    });
  }

  public async recordCoverageSegment(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    summary: IngestionJobExecutionSummary,
  ): Promise<void> {
    const status = summary.dataOutcome === 'PARTIAL'
      ? 'PARTIAL'
      : summary.dataOutcome === 'INVALID_CONFIGURATION' || summary.dataOutcome === 'PROVIDER_ERROR'
        ? 'INVALID'
        : 'COVERED';
    await tx.ingestionCoverageSegment.create({
      data: {
        id: `coverage_${job.id}`,
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        ingestionJobId: job.id,
        sourceType: job.sourceType,
        scopeKey: this.resolveScopeKey(job),
        status,
        targetStart: job.targetStart,
        targetEnd: job.targetEnd,
        ...(job.configurationHash !== undefined ? { configurationHash: job.configurationHash } : {}),
        rowsWritten: summary.focusRowsInserted,
        samplesWritten: summary.metricSamples,
        objectsProcessed: summary.objectsProcessed,
        evidence: summary.coverage as Prisma.InputJsonValue,
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
    metricSamplesProcessed: number,
    metricLinkage: ResourceLinkageRunStats,
  ): Promise<void> {
    await tx.dataQualityCheck.create({
      data: {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        sourceType: job.sourceType,
        checkName: 'ingestion_job_execution',
        status: this.resolveQualityStatus(result, metricSamplesProcessed),
        expectedAt: job.targetEnd,
        details: {
          jobId: job.id,
          dataOutcome: this.resolveDataOutcome(result, metricSamplesProcessed),
          apiCallCount: result.apiCallCount,
          objectsProcessed: result.objectsProcessed,
          focusRows: focusRowsProcessed,
          focusRowsInserted,
          costMetrics: costMetricProjection.projected,
          costMetricsInserted: costMetricProjection.inserted,
          historicalResourcesInserted: costMetricProjection.historicalResourcesInserted ?? 0,
          resources: resourcesPersisted,
          metricDerivedResources,
          metricSamples: metricSamplesProcessed,
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
    metricSamplesProcessed: number,
    metricLinkage: ResourceLinkageRunStats,
  ): IngestionJobExecutionSummary {
    const dataOutcome = this.resolveDataOutcome(result, metricSamplesProcessed);
    return {
      durationMs,
      providerCode: job.connection.providerCode,
      sourceType: job.sourceType,
      dataOutcome,
      apiCallCount: result.apiCallCount,
      objectsProcessed: result.objectsProcessed,
      focusRows: focusRowsProcessed,
      focusRowsInserted,
      costMetrics: costMetricProjection.projected,
      costMetricsInserted: costMetricProjection.inserted,
      resources: resourcesPersisted,
      metricDerivedResources,
      metricSamples: metricSamplesProcessed,
      metricSamplesLinkedToResource,
      resourceLinkage: { costs: costMetricProjection.linkage, metrics: metricLinkage },
      warnings: result.warnings,
      coverage: {
        ...result.coverage,
        historicalResourcesInserted: costMetricProjection.historicalResourcesInserted ?? 0,
      },
    };
  }

  public resolveDataOutcome(
    result: CloudIngestionResult,
    metricSamplesProcessed = result.metricSamples.length,
  ): IngestionDataOutcome {
    if (result.dataOutcome !== undefined) return result.dataOutcome;
    const hasData = result.focusRows.length > 0
      || (result.providerCostRows?.length ?? 0) > 0
      || result.resources.length > 0
      || metricSamplesProcessed > 0
      || result.objectsProcessed > 0;
    if (result.apiCallCount === 0 && !hasData) return 'INVALID_CONFIGURATION';
    if (result.warnings.length > 0) return 'PARTIAL';
    return hasData ? 'DATA_WRITTEN' : 'NO_DATA';
  }

  private resolveQualityStatus(result: CloudIngestionResult, metricSamplesProcessed = result.metricSamples.length): 'PASSED' | 'WARNING' | 'FAILED' {
    return this.resolveDataOutcome(result, metricSamplesProcessed) === 'DATA_WRITTEN' && result.warnings.length === 0
      ? 'PASSED'
      : 'WARNING';
  }

  private resolveScopeKey(job: CloudIngestionJobContext): string {
    const value = job.requestContext?.['scopeKey'];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'global';
  }

  private calculateFreshnessDeadline(job: CloudIngestionJobContext): Date {
    const hours = job.sourceType === 'BILLING_EXPORT' ? 30 : 1;
    return new Date(job.targetEnd.getTime() + hours * 60 * 60 * 1000);
  }
}
