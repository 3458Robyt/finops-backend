import type {
  ClaimedRecommendationAnalysisRun,
  CompleteRecommendationAnalysisRunInput,
  IRecommendationAnalysisRunRepository,
  PreparedRecommendationAnalysisRunInput,
  QueueRecommendationAnalysisRunInput,
} from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type {
  RecommendationAnalysisRun,
} from '../../domain/models/RecommendationAnalysisRun.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  runDetailInclude,
  runInclude,
  toRecommendationAnalysisRunDomain,
} from './mappers/recommendationAnalysisRunMappers.js';
import { completeRecommendationAnalysisRun } from './queries/recommendationAnalysisRunCompletion.js';

const toDomain = toRecommendationAnalysisRunDomain;

export class PrismaRecommendationAnalysisRunRepository implements IRecommendationAnalysisRunRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async queue(
    input: QueueRecommendationAnalysisRunInput,
  ): Promise<{ readonly run: RecommendationAnalysisRun; readonly reused: boolean }> {
    const scopeKey = input.cloudResourceId ?? input.externalResourceId ?? '__tenant__';

    try {
      const row = await this.prisma.recommendationAnalysisRun.create({
        data: {
          tenantId: input.tenantId,
          ...(input.requestedByUserId !== undefined ? { requestedByUserId: input.requestedByUserId } : {}),
          ...(input.retriedFromRunId !== undefined ? { retriedFromRunId: input.retriedFromRunId } : {}),
          trigger: input.trigger,
          scope: input.scope,
          scopeKey,
          ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
          ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
          ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        },
        include: runInclude,
      });
      return { run: toDomain(row), reused: false };
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }

      const active = await this.prisma.recommendationAnalysisRun.findFirst({
        where: {
          tenantId: input.tenantId,
          scopeKey,
          status: { in: ['PENDING', 'RUNNING'] },
        },
        orderBy: { createdAt: 'desc' },
        include: runInclude,
      });
      if (active === null) throw error;
      return { run: toDomain(active), reused: true };
    }
  }

  public async findById(tenantId: string, runId: string): Promise<RecommendationAnalysisRun | null> {
    const row = await this.prisma.recommendationAnalysisRun.findFirst({
      where: { id: runId, tenantId },
      include: runDetailInclude,
    });
    return row === null ? null : toDomain(row);
  }

  public async listByTenant(tenantId: string, limit = 50): Promise<RecommendationAnalysisRun[]> {
    const rows = await this.prisma.recommendationAnalysisRun.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: runInclude,
    });
    return rows.map(toDomain);
  }

  public async cancelPending(tenantId: string, runId: string): Promise<RecommendationAnalysisRun | null> {
    const result = await this.prisma.recommendationAnalysisRun.updateMany({
      where: { id: runId, tenantId, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        stage: 'FINISHED',
        completedAt: new Date(),
        nextAttemptAt: null,
        cancelRequestedAt: null,
        lockedAt: null,
        workerId: null,
        errorCode: 'CANCELLED_BY_USER',
        errorMessage: 'La corrida fue cancelada por el usuario antes de iniciar.',
      },
    });
    return result.count === 0 ? null : this.findById(tenantId, runId);
  }

  public async requestCancellation(
    tenantId: string,
    runId: string,
    staleBefore: Date,
  ): Promise<RecommendationAnalysisRun | null> {
    const requestedAt = new Date();
    const staleResult = await this.prisma.recommendationAnalysisRun.updateMany({
      where: {
        id: runId,
        tenantId,
        status: 'RUNNING',
        stage: { not: 'PERSISTENCE' },
        lockedAt: { lt: staleBefore },
      },
      data: {
        status: 'CANCELLED',
        stage: 'FINISHED',
        completedAt: requestedAt,
        nextAttemptAt: null,
        cancelRequestedAt: null,
        lockedAt: null,
        workerId: null,
        errorCode: 'CANCELLED_STALE_RUN',
        errorMessage: 'La corrida fue cancelada porque su worker dejó de responder.',
      },
    });
    if (staleResult.count > 0) return this.findById(tenantId, runId);

    const requestResult = await this.prisma.recommendationAnalysisRun.updateMany({
      // PERSISTENCE is a short publication fence. Once entered, cancellation
      // must wait for the atomic run finalization instead of leaving orphaned
      // recommendations between the two writes.
      where: { id: runId, tenantId, status: 'RUNNING', stage: { not: 'PERSISTENCE' } },
      data: { cancelRequestedAt: requestedAt },
    });
    if (requestResult.count > 0) return this.findById(tenantId, runId);

    const current = await this.findById(tenantId, runId);
    return current?.status === 'RUNNING' ? current : null;
  }

  public async isCancellationRequested(runId: string): Promise<boolean> {
    const row = await this.prisma.recommendationAnalysisRun.findUnique({
      where: { id: runId },
      select: { status: true, cancelRequestedAt: true },
    });
    return row?.status === 'CANCELLED' || row?.cancelRequestedAt !== null;
  }

  public async finalizeCancellation(runId: string): Promise<RecommendationAnalysisRun | null> {
    const result = await this.prisma.recommendationAnalysisRun.updateMany({
      where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'CANCELLED',
        stage: 'FINISHED',
        completedAt: new Date(),
        nextAttemptAt: null,
        cancelRequestedAt: null,
        lockedAt: null,
        workerId: null,
        errorCode: 'CANCELLED_BY_USER',
        errorMessage: 'La corrida fue cancelada por el usuario.',
      },
    });
    if (result.count === 0) return null;
    const row = await this.prisma.recommendationAnalysisRun.findUnique({ where: { id: runId }, include: runInclude });
    return row === null ? null : toDomain(row);
  }

  public async retryFailed(
    tenantId: string,
    runId: string,
    requestedByUserId: string,
  ): Promise<RecommendationAnalysisRun | null> {
    const source = await this.prisma.recommendationAnalysisRun.findFirst({
      where: { id: runId, tenantId, status: 'FAILED' },
    });
    if (source === null) return null;

    const queued = await this.queue({
      tenantId,
      requestedByUserId,
      retriedFromRunId: source.id,
      trigger: 'RETRY',
      scope: source.scope,
      ...(source.externalResourceId !== null ? { externalResourceId: source.externalResourceId } : {}),
      ...(source.cloudResourceId !== null ? { cloudResourceId: source.cloudResourceId } : {}),
      maxAttempts: source.maxAttempts,
    });
    return queued.run;
  }

  public async claimNext(workerId: string, staleBefore: Date): Promise<ClaimedRecommendationAnalysisRun | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "recommendation_analysis_runs"
        SET
          "status" = 'FAILED',
          "stage" = 'FINISHED',
          "error_code" = 'WORKER_ATTEMPTS_EXHAUSTED',
          "error_message" = 'La corrida agotó sus intentos después de una interrupción.',
          "completed_at" = NOW(),
          "updated_at" = NOW()
        WHERE "status" = 'RUNNING'
          AND "locked_at" < ${staleBefore}
          AND "attempts" >= "max_attempts"
      `;

      await tx.$executeRaw`
        UPDATE "recommendation_analysis_runs"
        SET
          "status" = 'CANCELLED',
          "stage" = 'FINISHED',
          "error_code" = 'CANCELLED_BY_USER',
          "error_message" = 'La corrida fue cancelada por el usuario.',
          "completed_at" = NOW(),
          "cancel_requested_at" = NULL,
          "locked_at" = NULL,
          "worker_id" = NULL,
          "next_attempt_at" = NULL,
          "updated_at" = NOW()
        WHERE "status" = 'RUNNING'
          AND "cancel_requested_at" IS NOT NULL
          AND "locked_at" < ${staleBefore}
      `;

      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "recommendation_analysis_runs"
        WHERE (
          (
            "status" = 'PENDING'
            AND "cancel_requested_at" IS NULL
            AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= NOW())
          )
          OR
          (
            "status" = 'RUNNING'
            AND "locked_at" < ${staleBefore}
          )
        )
          AND "attempts" < "max_attempts"
        ORDER BY "created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const candidate = candidates[0];
      if (candidate === undefined) return null;

      const row = await tx.recommendationAnalysisRun.update({
        where: { id: candidate.id },
        data: {
          status: 'RUNNING',
          stage: 'SELECTING_DATA',
          attempts: { increment: 1 },
          workerId,
          lockedAt: new Date(),
          startedAt: new Date(),
          nextAttemptAt: null,
          cancelRequestedAt: null,
          errorCode: null,
          errorMessage: null,
        },
        include: runInclude,
      });
      return toDomain(row) as ClaimedRecommendationAnalysisRun;
    });
  }

  public async updateStage(
    runId: string,
    stage: Parameters<IRecommendationAnalysisRunRepository['updateStage']>[1],
  ): Promise<void> {
    await this.prisma.recommendationAnalysisRun.updateMany({
      where: { id: runId, status: 'RUNNING', cancelRequestedAt: null },
      data: { stage, lockedAt: new Date() },
    });
  }

  public async savePrepared(runId: string, input: PreparedRecommendationAnalysisRunInput): Promise<void> {
    await this.prisma.recommendationAnalysisRun.updateMany({
      where: { id: runId, status: 'RUNNING', cancelRequestedAt: null },
      data: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        evidenceHash: input.evidenceHash,
        snapshot: input.snapshot as Prisma.InputJsonValue,
        ...(input.evidenceSnapshot !== undefined
          ? { evidenceSnapshot: input.evidenceSnapshot as Prisma.InputJsonValue }
          : {}),
        readinessReport: input.readinessReport as Prisma.InputJsonValue,
        resourcesEvaluated: input.resourcesEvaluated,
        candidatesFound: input.candidatesFound,
        candidatesSkipped: input.candidatesSkipped,
        candidateResults: input.candidateResults as unknown as Prisma.InputJsonValue,
        model: input.model,
        auditorModel: input.auditorModel,
        lockedAt: new Date(),
      },
    });
  }

  public async findEquivalentCompleted(
    tenantId: string,
    scopeKey: string,
    periodStart: Date,
    periodEnd: Date,
    evidenceHash: string,
    excludeRunId: string,
  ): Promise<RecommendationAnalysisRun | null> {
    const row = await this.prisma.recommendationAnalysisRun.findFirst({
      where: {
        tenantId,
        scopeKey,
        periodStart,
        periodEnd,
        evidenceHash,
        id: { not: excludeRunId },
        status: { in: ['COMPLETED', 'PARTIAL', 'SKIPPED'] },
      },
      orderBy: { completedAt: 'desc' },
      include: runInclude,
    });
    return row === null ? null : toDomain(row);
  }

  public async complete(
    runId: string,
    input: CompleteRecommendationAnalysisRunInput,
  ): Promise<RecommendationAnalysisRun> {
    const row = await completeRecommendationAnalysisRun(this.prisma, runId, input);
    return toDomain(row);
  }

  public async recordFailure(
    runId: string,
    input: {
      readonly code: string;
      readonly message: string;
      readonly retryAt: Date;
      readonly stageTimings?: Readonly<Record<string, number>>;
    },
  ): Promise<RecommendationAnalysisRun> {
    const current = await this.prisma.recommendationAnalysisRun.findUniqueOrThrow({ where: { id: runId } });
    if (current.status === 'CANCELLED' || current.cancelRequestedAt !== null) {
      return (await this.finalizeCancellation(runId)) ?? toDomain(await this.prisma.recommendationAnalysisRun.findUniqueOrThrow({ where: { id: runId }, include: runInclude }));
    }
    const retry = current.attempts < current.maxAttempts;
    const row = await this.prisma.recommendationAnalysisRun.update({
      where: { id: runId },
      data: {
        status: retry ? 'PENDING' : 'FAILED',
        stage: retry ? 'QUEUED' : 'FINISHED',
        errorCode: input.code,
        errorMessage: input.message,
        ...(input.stageTimings === undefined ? {} : { stageTimings: input.stageTimings as Prisma.InputJsonValue }),
        nextAttemptAt: retry ? input.retryAt : null,
        completedAt: retry ? null : new Date(),
        workerId: null,
        lockedAt: null,
        cancelRequestedAt: null,
      },
      include: runInclude,
    });
    return toDomain(row);
  }
}
