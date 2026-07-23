import type {
  ClaimedRecommendationAnalysisRun,
  CompleteRecommendationAnalysisRunInput,
  IRecommendationAnalysisRunRepository,
  PreparedRecommendationAnalysisRunInput,
  QueueRecommendationAnalysisRunInput,
} from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type {
  RecommendationAnalysisCandidateResult,
  RecommendationAnalysisRun,
} from '../../domain/models/RecommendationAnalysisRun.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

const runInclude = {
  recommendationLinks: {
    include: {
      recommendation: {
        select: { title: true },
      },
    },
  },
} as const;

type RunRow = Prisma.RecommendationAnalysisRunGetPayload<{ include: typeof runInclude }>;

export class PrismaRecommendationAnalysisRunRepository implements IRecommendationAnalysisRunRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async queue(
    input: QueueRecommendationAnalysisRunInput,
  ): Promise<{ readonly run: RecommendationAnalysisRun; readonly reused: boolean }> {
    const scopeKey = input.externalResourceId ?? '__tenant__';

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
      include: runInclude,
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
      },
    });
    return result.count === 0 ? null : this.findById(tenantId, runId);
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

      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "recommendation_analysis_runs"
        WHERE (
          (
            "status" = 'PENDING'
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
      where: { id: runId, status: 'RUNNING' },
      data: { stage, lockedAt: new Date() },
    });
  }

  public async savePrepared(runId: string, input: PreparedRecommendationAnalysisRunInput): Promise<void> {
    await this.prisma.recommendationAnalysisRun.update({
      where: { id: runId },
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
    const row = await this.prisma.$transaction(async (tx) => {
      if (input.recommendationLinks.length > 0) {
        await tx.recommendationAnalysisRunRecommendation.createMany({
          data: input.recommendationLinks.map((link) => ({
            runId,
            recommendationId: link.recommendationId,
            ...(link.candidateId !== undefined ? { candidateId: link.candidateId } : {}),
            disposition: link.disposition,
          })),
          skipDuplicates: true,
        });
      }

      return tx.recommendationAnalysisRun.update({
        where: { id: runId },
        data: {
          status: input.status,
          stage: 'FINISHED',
          candidateResults: input.candidateResults as unknown as Prisma.InputJsonValue,
          recommendationsGenerated: input.recommendationsGenerated,
          recommendationsRejected: input.recommendationsRejected,
          recommendationsPersisted: input.recommendationLinks.length,
          promptTokenEstimate: input.promptTokenEstimate,
          responseTokenEstimate: input.responseTokenEstimate,
          latencyMs: input.latencyMs,
          ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : { errorCode: null }),
          ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : { errorMessage: null }),
          completedAt: new Date(),
          lockedAt: null,
          workerId: null,
          nextAttemptAt: null,
        },
        include: runInclude,
      });
    });
    return toDomain(row);
  }

  public async recordFailure(
    runId: string,
    input: { readonly code: string; readonly message: string; readonly retryAt: Date },
  ): Promise<RecommendationAnalysisRun> {
    const current = await this.prisma.recommendationAnalysisRun.findUniqueOrThrow({ where: { id: runId } });
    const retry = current.attempts < current.maxAttempts;
    const row = await this.prisma.recommendationAnalysisRun.update({
      where: { id: runId },
      data: {
        status: retry ? 'PENDING' : 'FAILED',
        stage: retry ? 'QUEUED' : 'FINISHED',
        errorCode: input.code,
        errorMessage: input.message,
        nextAttemptAt: retry ? input.retryAt : null,
        completedAt: retry ? null : new Date(),
        workerId: null,
        lockedAt: null,
      },
      include: runInclude,
    });
    return toDomain(row);
  }
}

function toDomain(row: RunRow): RecommendationAnalysisRun {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...(row.requestedByUserId !== null ? { requestedByUserId: row.requestedByUserId } : {}),
    ...(row.retriedFromRunId !== null ? { retriedFromRunId: row.retriedFromRunId } : {}),
    trigger: row.trigger,
    scope: row.scope,
    scopeKey: row.scopeKey,
    ...(row.externalResourceId !== null ? { externalResourceId: row.externalResourceId } : {}),
    status: row.status,
    stage: row.stage,
    ...(row.periodStart !== null ? { periodStart: row.periodStart } : {}),
    ...(row.periodEnd !== null ? { periodEnd: row.periodEnd } : {}),
    ...(row.evidenceHash !== null ? { evidenceHash: row.evidenceHash } : {}),
    ...(row.snapshot !== null ? { snapshot: row.snapshot } : {}),
    ...(row.evidenceSnapshot !== null ? { evidenceSnapshot: row.evidenceSnapshot } : {}),
    ...(row.readinessReport !== null ? { readinessReport: row.readinessReport } : {}),
    ...(row.candidateResults !== null
      ? { candidateResults: row.candidateResults as unknown as RecommendationAnalysisCandidateResult[] }
      : {}),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    resourcesEvaluated: row.resourcesEvaluated,
    candidatesFound: row.candidatesFound,
    candidatesSkipped: row.candidatesSkipped,
    recommendationsGenerated: row.recommendationsGenerated,
    recommendationsRejected: row.recommendationsRejected,
    recommendationsPersisted: row.recommendationsPersisted,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.auditorModel !== null ? { auditorModel: row.auditorModel } : {}),
    promptTokenEstimate: row.promptTokenEstimate,
    responseTokenEstimate: row.responseTokenEstimate,
    ...(row.latencyMs !== null ? { latencyMs: row.latencyMs } : {}),
    ...(row.workerId !== null ? { workerId: row.workerId } : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    recommendations: row.recommendationLinks.map((link) => ({
      recommendationId: link.recommendationId,
      ...(link.candidateId !== null ? { candidateId: link.candidateId } : {}),
      disposition: link.disposition,
      title: link.recommendation.title,
    })),
  };
}
