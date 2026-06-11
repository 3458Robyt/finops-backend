import type {
  CloudIngestionConnection,
  CloudIngestionCredential,
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedCloudResource,
  NormalizedFocusCostLineItem,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CredentialCipher, type EncryptedCredentialPayload } from '../security/CredentialCipher.js';
import {
  buildFocusCostMetricRows,
  getFocusCloudAccountExternalId,
  getFocusCloudAccountName,
} from './focusCostMetricProjection.js';

interface ClaimedJobRow {
  readonly id: string;
}

interface FocusCostMetricProjectionResult {
  readonly projected: number;
  readonly inserted: number;
}

type PrismaIngestionJobWithConnection = NonNullable<Awaited<ReturnType<PrismaCloudIngestionJobRepository['findJobContext']>>>;
type PrismaIngestionPersistenceClient = Pick<
  Prisma.TransactionClient,
  | 'cloudResource'
  | 'cloudAccount'
  | 'costMetric'
  | 'dataQualityCheck'
  | 'focusCostLineItem'
  | 'ingestionJob'
  | 'ingestionWatermark'
  | 'resourceMetricSample'
>;

export interface IngestionJobExecutionSummary {
  readonly durationMs: number;
  readonly providerCode: string;
  readonly sourceType: IngestionSourceType;
  readonly apiCallCount: number;
  readonly objectsProcessed: number;
  readonly focusRows: number;
  readonly costMetrics: number;
  readonly costMetricsInserted: number;
  readonly resources: number;
  readonly metricSamples: number;
  readonly warnings: readonly string[];
  readonly coverage: Readonly<Record<string, unknown>>;
}

export class PrismaCloudIngestionJobRepository {
  private static readonly COMPLETION_TRANSACTION_OPTIONS = {
    maxWait: 10_000,
    timeout: 60_000,
  } as const;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialCipher: CredentialCipher,
  ) {}

  public async claimNextPendingJob(workerId: string): Promise<CloudIngestionJobContext | null> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedJobRow[]>`
        SELECT id
        FROM ingestion_jobs
        WHERE status = 'PENDING'
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

  public async completeJob(
    job: CloudIngestionJobContext,
    result: CloudIngestionResult,
    startedAt: Date,
  ): Promise<IngestionJobExecutionSummary> {
    await this.upsertFocusRows(this.prisma, result.focusRows);
    const costMetricProjection = await this.projectFocusRowsToCostMetrics(this.prisma, job, result.focusRows);
    await this.upsertResources(this.prisma, result.resources);
    await this.insertMetricSamples(this.prisma, result.metricSamples);

    const completedAt = new Date();
    const summary = this.buildSummary(
      job,
      result,
      completedAt.getTime() - startedAt.getTime(),
      costMetricProjection,
    );

    await this.prisma.$transaction(
      async (tx) => {
        await this.updateWatermark(tx, job);
        await this.recordQualityCheck(tx, job, result, costMetricProjection);

        await tx.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCESS',
            completedAt,
            lockedAt: null,
            lockedBy: null,
            errorMessage: null,
            resultSummary: summary as unknown as Prisma.InputJsonValue,
          },
        });
      },
      PrismaCloudIngestionJobRepository.COMPLETION_TRANSACTION_OPTIONS,
    );

    return summary;
  }

  public async failJob(
    job: CloudIngestionJobContext,
    error: unknown,
    startedAt: Date,
  ): Promise<void> {
    const completedAt = new Date();
    const message = error instanceof Error ? error.message : 'Unknown ingestion worker error';
    const current = await this.prisma.ingestionJob.findUnique({
      where: { id: job.id },
      select: { attempts: true, maxAttempts: true },
    });
    const shouldRetry = current !== null && current.attempts < current.maxAttempts;

    await this.prisma.ingestionJob.update({
      where: { id: job.id },
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
        } as Prisma.InputJsonValue,
      },
    });

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
        } as Prisma.InputJsonValue,
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

  private async upsertFocusRows(
    tx: PrismaIngestionPersistenceClient,
    rows: readonly NormalizedFocusCostLineItem[],
  ): Promise<void> {
    for (const row of rows) {
      await tx.focusCostLineItem.upsert({
        where: {
          cloudConnectionId_chargePeriodStart_lineItemHash: {
            cloudConnectionId: row.cloudConnectionId,
            chargePeriodStart: row.chargePeriodStart,
            lineItemHash: row.lineItemHash,
          },
        },
        update: this.focusRowData(row),
        create: this.focusRowData(row),
      });
    }
  }

  private focusRowData(row: NormalizedFocusCostLineItem): Prisma.FocusCostLineItemUncheckedCreateInput {
    return {
      tenantId: row.tenantId,
      cloudConnectionId: row.cloudConnectionId,
      provider: row.provider,
      focusVersion: row.focusVersion,
      chargePeriodStart: row.chargePeriodStart,
      chargePeriodEnd: row.chargePeriodEnd,
      ...(row.billingPeriodStart !== undefined ? { billingPeriodStart: row.billingPeriodStart } : {}),
      ...(row.billingPeriodEnd !== undefined ? { billingPeriodEnd: row.billingPeriodEnd } : {}),
      ...(row.billingAccountId !== undefined ? { billingAccountId: row.billingAccountId } : {}),
      ...(row.subAccountId !== undefined ? { subAccountId: row.subAccountId } : {}),
      serviceName: row.serviceName,
      resourceId: row.resourceId,
      ...(row.regionId !== undefined ? { regionId: row.regionId } : {}),
      chargeCategory: row.chargeCategory,
      billedCost: new Prisma.Decimal(row.billedCost),
      ...(row.effectiveCost !== undefined ? { effectiveCost: new Prisma.Decimal(row.effectiveCost) } : {}),
      ...(row.listCost !== undefined ? { listCost: new Prisma.Decimal(row.listCost) } : {}),
      ...(row.contractedCost !== undefined ? { contractedCost: new Prisma.Decimal(row.contractedCost) } : {}),
      billingCurrency: row.billingCurrency,
      ...(row.consumedQuantity !== undefined
        ? { consumedQuantity: new Prisma.Decimal(row.consumedQuantity) }
        : {}),
      ...(row.consumedUnit !== undefined ? { consumedUnit: row.consumedUnit } : {}),
      ...(row.tags !== undefined ? { tags: row.tags as Prisma.InputJsonValue } : {}),
      rawRow: row.rawRow as Prisma.InputJsonValue,
      lineItemHash: row.lineItemHash,
    };
  }

  private async upsertResources(
    tx: PrismaIngestionPersistenceClient,
    resources: readonly NormalizedCloudResource[],
  ): Promise<void> {
    for (const resource of resources) {
      const updateData: Prisma.CloudResourceUncheckedUpdateInput = {
        resourceType: resource.resourceType,
        serviceName: resource.serviceName,
        status: resource.status,
        lastSeenAt: new Date(),
        ...(resource.name !== undefined ? { name: resource.name } : {}),
        ...(resource.regionId !== undefined ? { regionId: resource.regionId } : {}),
        ...(resource.tags !== undefined ? { tags: resource.tags as Prisma.InputJsonValue } : {}),
        ...(resource.rawResource !== undefined
          ? { rawResource: resource.rawResource as Prisma.InputJsonValue }
          : {}),
      };
      const createData: Prisma.CloudResourceUncheckedCreateInput = {
        tenantId: resource.tenantId,
        cloudConnectionId: resource.cloudConnectionId,
        provider: resource.provider,
        externalResourceId: resource.externalResourceId,
        resourceType: resource.resourceType,
        serviceName: resource.serviceName,
        status: resource.status,
        ...(resource.name !== undefined ? { name: resource.name } : {}),
        ...(resource.regionId !== undefined ? { regionId: resource.regionId } : {}),
        ...(resource.tags !== undefined ? { tags: resource.tags as Prisma.InputJsonValue } : {}),
        ...(resource.rawResource !== undefined
          ? { rawResource: resource.rawResource as Prisma.InputJsonValue }
          : {}),
      };

      await tx.cloudResource.upsert({
        where: {
          cloudConnectionId_externalResourceId: {
            cloudConnectionId: resource.cloudConnectionId,
            externalResourceId: resource.externalResourceId,
          },
        },
        update: updateData,
        create: createData,
      });
    }
  }

  private async insertMetricSamples(
    tx: PrismaIngestionPersistenceClient,
    samples: readonly NormalizedResourceMetricSample[],
  ): Promise<void> {
    if (samples.length === 0) {
      return;
    }

    await tx.resourceMetricSample.createMany({
      data: samples.map((sample) => ({
        tenantId: sample.tenantId,
        cloudConnectionId: sample.cloudConnectionId,
        provider: sample.provider,
        externalResourceId: sample.externalResourceId,
        metricName: sample.metricName,
        value: new Prisma.Decimal(sample.value),
        sampledAt: sample.sampledAt,
        granularitySeconds: sample.granularitySeconds,
        sourceType: 'TECHNICAL_METRIC',
        ...(sample.metricUnit !== undefined ? { metricUnit: sample.metricUnit } : {}),
        ...(sample.rawMetric !== undefined ? { rawMetric: sample.rawMetric as Prisma.InputJsonValue } : {}),
      })),
      skipDuplicates: true,
    });
  }

  private async updateWatermark(
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

  private async recordQualityCheck(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    result: CloudIngestionResult,
    costMetricProjection: FocusCostMetricProjectionResult,
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
          focusRows: result.focusRows.length,
          costMetrics: costMetricProjection.projected,
          costMetricsInserted: costMetricProjection.inserted,
          resources: result.resources.length,
          metricSamples: result.metricSamples.length,
          warnings: result.warnings,
          coverage: result.coverage,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private buildSummary(
    job: CloudIngestionJobContext,
    result: CloudIngestionResult,
    durationMs: number,
    costMetricProjection: FocusCostMetricProjectionResult,
  ): IngestionJobExecutionSummary {
    return {
      durationMs,
      providerCode: job.connection.providerCode,
      sourceType: job.sourceType,
      apiCallCount: result.apiCallCount,
      objectsProcessed: result.objectsProcessed,
      focusRows: result.focusRows.length,
      costMetrics: costMetricProjection.projected,
      costMetricsInserted: costMetricProjection.inserted,
      resources: result.resources.length,
      metricSamples: result.metricSamples.length,
      warnings: result.warnings,
      coverage: result.coverage,
    };
  }

  private async projectFocusRowsToCostMetrics(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    rows: readonly NormalizedFocusCostLineItem[],
  ): Promise<FocusCostMetricProjectionResult> {
    if (rows.length === 0) {
      return { projected: 0, inserted: 0 };
    }

    const accountIdsByExternalId = await this.upsertFocusCloudAccounts(tx, job, rows);
    const result = await tx.costMetric.createMany({
      data: buildFocusCostMetricRows({
        job,
        rows,
        accountIdsByExternalId,
      }),
      skipDuplicates: true,
    });

    return {
      projected: rows.length,
      inserted: result.count,
    };
  }

  private async upsertFocusCloudAccounts(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    rows: readonly NormalizedFocusCostLineItem[],
  ): Promise<ReadonlyMap<string, string>> {
    const samplesByExternalId = new Map<string, NormalizedFocusCostLineItem>();
    for (const row of rows) {
      const externalId = getFocusCloudAccountExternalId(job, row);
      if (!samplesByExternalId.has(externalId)) {
        samplesByExternalId.set(externalId, row);
      }
    }

    const accountIdsByExternalId = new Map<string, string>();
    for (const [externalId, row] of samplesByExternalId) {
      const account = await tx.cloudAccount.upsert({
        where: {
          tenantId_provider_externalAccountId: {
            tenantId: job.tenantId,
            provider: row.provider,
            externalAccountId: externalId,
          },
        },
        update: {
          name: getFocusCloudAccountName(job, row),
          status: 'ACTIVE',
          ...(job.connection.defaultRegion !== undefined ? { defaultRegion: job.connection.defaultRegion } : {}),
        },
        create: {
          tenantId: job.tenantId,
          provider: row.provider,
          externalAccountId: externalId,
          name: getFocusCloudAccountName(job, row),
          ...(job.connection.defaultRegion !== undefined ? { defaultRegion: job.connection.defaultRegion } : {}),
        },
        select: { id: true },
      });
      accountIdsByExternalId.set(externalId, account.id);
    }

    return accountIdsByExternalId;
  }

  private calculateFreshnessDeadline(job: CloudIngestionJobContext): Date {
    const hours = job.sourceType === 'BILLING_EXPORT' ? 30 : 1;
    return new Date(job.targetEnd.getTime() + hours * 60 * 60 * 1000);
  }

  private isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
