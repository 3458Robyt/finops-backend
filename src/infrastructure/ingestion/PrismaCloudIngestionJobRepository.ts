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
  readonly focusRowsInserted: number;
  readonly costMetrics: number;
  readonly costMetricsInserted: number;
  readonly resources: number;
  readonly metricDerivedResources: number;
  readonly metricSamples: number;
  readonly metricSamplesLinkedToResource: number;
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
    const leaseExpiredBefore = new Date(now.getTime() - readPositiveIntegerEnv('INGESTION_JOB_LEASE_MS', 300_000));

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
    let focusRowsProcessed = result.focusRows.length;
    let focusRowsInserted = await this.insertFocusRows(this.prisma, result.focusRows);
    let costMetricProjection = await this.projectFocusRowsToCostMetrics(this.prisma, job, result.focusRows);

    if (result.focusBatches !== undefined) {
      for await (const batch of result.focusBatches) {
        focusRowsProcessed += batch.length;
        focusRowsInserted += await this.insertFocusRows(this.prisma, batch);
        const batchProjection = await this.projectFocusRowsToCostMetrics(this.prisma, job, batch);
        costMetricProjection = {
          projected: costMetricProjection.projected + batchProjection.projected,
          inserted: costMetricProjection.inserted + batchProjection.inserted,
        };
      }
    }

    const metricDerivedResources = this.buildMetricDerivedResources(job, result.metricSamples);
    const resources = this.mergeResources([...result.resources, ...metricDerivedResources]);
    const resourceIdsByExternalId = await this.upsertResources(this.prisma, resources);
    const metricSamplesLinkedToResource = await this.insertMetricSamples(
      this.prisma,
      result.metricSamples,
      resourceIdsByExternalId,
    );
    await this.reconcileMetricSampleResourceLinks(this.prisma, job.cloudConnectionId, resourceIdsByExternalId);

    const completedAt = new Date();
    const summary = this.buildSummary(
      job,
      result,
      completedAt.getTime() - startedAt.getTime(),
      costMetricProjection,
      focusRowsInserted,
      focusRowsProcessed,
      resources.length,
      metricDerivedResources.length,
      metricSamplesLinkedToResource,
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

        await this.updateWatermark(tx, job);
        await this.recordQualityCheck(
          tx,
          job,
          result,
          costMetricProjection,
          focusRowsInserted,
          focusRowsProcessed,
          resources.length,
          metricDerivedResources.length,
          metricSamplesLinkedToResource,
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
        } as Prisma.InputJsonValue,
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

  private async insertFocusRows(
    tx: PrismaIngestionPersistenceClient,
    rows: readonly NormalizedFocusCostLineItem[],
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    let inserted = 0;
    for (const chunk of chunkArray(rows, 1000)) {
      const result = await tx.focusCostLineItem.createMany({
        data: chunk.map((row) => this.focusRowData(row)),
        skipDuplicates: true,
      });
      inserted += result.count;
    }

    return inserted;
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
  ): Promise<ReadonlyMap<string, string>> {
    const resourceIdsByExternalId = new Map<string, string>();

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

      const persisted = await tx.cloudResource.upsert({
        where: {
          cloudConnectionId_externalResourceId: {
            cloudConnectionId: resource.cloudConnectionId,
            externalResourceId: resource.externalResourceId,
          },
        },
        update: updateData,
        create: createData,
        select: {
          id: true,
          externalResourceId: true,
        },
      });
      resourceIdsByExternalId.set(persisted.externalResourceId, persisted.id);
    }

    return resourceIdsByExternalId;
  }

  private async insertMetricSamples(
    tx: PrismaIngestionPersistenceClient,
    samples: readonly NormalizedResourceMetricSample[],
    resourceIdsByExternalId: ReadonlyMap<string, string>,
  ): Promise<number> {
    if (samples.length === 0) {
      return 0;
    }

    let linked = 0;
    await tx.resourceMetricSample.createMany({
      data: samples.map((sample) => {
        const cloudResourceId = resourceIdsByExternalId.get(sample.externalResourceId);
        if (cloudResourceId !== undefined) {
          linked += 1;
        }

        return {
          tenantId: sample.tenantId,
          cloudConnectionId: sample.cloudConnectionId,
          provider: sample.provider,
          externalResourceId: sample.externalResourceId,
          metricName: sample.metricName,
          value: new Prisma.Decimal(sample.value),
          sampledAt: sample.sampledAt,
          granularitySeconds: sample.granularitySeconds,
          sourceType: 'TECHNICAL_METRIC',
          ...(cloudResourceId !== undefined ? { cloudResourceId } : {}),
          ...(sample.metricUnit !== undefined ? { metricUnit: sample.metricUnit } : {}),
          ...(sample.rawMetric !== undefined ? { rawMetric: sample.rawMetric as Prisma.InputJsonValue } : {}),
        };
      }),
      skipDuplicates: true,
    });

    return linked;
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
    focusRowsInserted: number,
    focusRowsProcessed: number,
    resourcesPersisted: number,
    metricDerivedResources: number,
    metricSamplesLinkedToResource: number,
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
          resources: resourcesPersisted,
          metricDerivedResources,
          metricSamples: result.metricSamples.length,
          metricSamplesLinkedToResource,
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
    focusRowsInserted: number,
    focusRowsProcessed: number,
    resourcesPersisted: number,
    metricDerivedResources: number,
    metricSamplesLinkedToResource: number,
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
      warnings: result.warnings,
      coverage: result.coverage,
    };
  }

  private buildMetricDerivedResources(
    job: CloudIngestionJobContext,
    samples: readonly NormalizedResourceMetricSample[],
  ): readonly NormalizedCloudResource[] {
    const byExternalResourceId = new Map<string, {
      sample: NormalizedResourceMetricSample;
      metricNames: Set<string>;
      sampleCount: number;
    }>();

    for (const sample of samples) {
      const current = byExternalResourceId.get(sample.externalResourceId);
      if (current === undefined) {
        byExternalResourceId.set(sample.externalResourceId, {
          sample,
          metricNames: new Set([sample.metricName]),
          sampleCount: 1,
        });
        continue;
      }

      current.metricNames.add(sample.metricName);
      current.sampleCount += 1;
    }

    return [...byExternalResourceId.values()].map(({ sample, metricNames, sampleCount }) => {
      const regionId = this.readRawMetricString(sample.rawMetric, 'region') ?? job.connection.defaultRegion;
      return {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        provider: sample.provider,
        externalResourceId: sample.externalResourceId,
        name: this.readRawMetricString(sample.rawMetric, 'resourceName') ?? sample.externalResourceId,
        resourceType: this.inferResourceType(sample),
        serviceName: this.inferServiceName(sample),
        ...(regionId !== undefined ? { regionId } : {}),
        status: 'UNKNOWN',
        rawResource: {
          source: 'METRIC_DERIVED',
          metricNames: [...metricNames].sort(),
          sampleCount,
        },
      };
    });
  }

  private mergeResources(resources: readonly NormalizedCloudResource[]): readonly NormalizedCloudResource[] {
    const byKey = new Map<string, NormalizedCloudResource>();

    for (const resource of resources) {
      const key = `${resource.cloudConnectionId}:${resource.externalResourceId}`;
      const previous = byKey.get(key);
      if (previous === undefined || previous.rawResource?.['source'] === 'METRIC_DERIVED') {
        byKey.set(key, resource);
      }
    }

    return [...byKey.values()];
  }

  private async reconcileMetricSampleResourceLinks(
    tx: PrismaIngestionPersistenceClient,
    cloudConnectionId: string,
    resourceIdsByExternalId: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const [externalResourceId, cloudResourceId] of resourceIdsByExternalId) {
      await tx.resourceMetricSample.updateMany({
        where: {
          cloudConnectionId,
          externalResourceId,
          cloudResourceId: null,
        },
        data: { cloudResourceId },
      });
    }
  }

  private inferResourceType(sample: NormalizedResourceMetricSample): string {
    const namespace = this.readRawMetricString(sample.rawMetric, 'namespace')?.toLowerCase() ?? '';
    if (namespace.includes('compute') || namespace.includes('ec2') || namespace.includes('vmi')) {
      return 'COMPUTE_INSTANCE';
    }

    if (namespace.includes('block') || namespace.includes('volume') || namespace.includes('ebs')) {
      return 'BLOCK_VOLUME';
    }

    return 'UNKNOWN';
  }

  private inferServiceName(sample: NormalizedResourceMetricSample): string {
    const namespace = this.readRawMetricString(sample.rawMetric, 'namespace')?.toLowerCase() ?? '';
    if (namespace.includes('aws/ec2')) {
      return 'Amazon EC2';
    }

    if (namespace.includes('oci_compute') || namespace.includes('oci_computeagent') || namespace.includes('vmi')) {
      return 'Oracle Compute';
    }

    if (namespace.includes('ebs')) {
      return 'Amazon EBS';
    }

    return 'UNKNOWN';
  }

  private readRawMetricString(
    rawMetric: Readonly<Record<string, unknown>> | undefined,
    field: string,
  ): string | undefined {
    if (rawMetric === undefined) {
      return undefined;
    }

    const value = rawMetric[field];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
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

function readPositiveIntegerEnv(key: string, defaultValue: number): number {
  const parsed = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function chunkArray<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}
