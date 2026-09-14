import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';
import type { CompleteRecommendationAnalysisRunInput } from '../../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import { runInclude } from '../mappers/recommendationAnalysisRunMappers.js';

export async function completeRecommendationAnalysisRun(
  prisma: PrismaClient,
  runId: string,
  input: CompleteRecommendationAnalysisRunInput,
) {
  return prisma.$transaction(async (tx) => {
    // Lock the active row before publishing links/audits. A cancellation
    // request that wins the race makes this conditional update return 0.
    // That prevents a cancelled run from publishing recommendations.
    const activeLock = await tx.recommendationAnalysisRun.updateMany({
      where: { id: runId, status: 'RUNNING', cancelRequestedAt: null },
      data: { lockedAt: new Date() },
    });
    const current = await tx.recommendationAnalysisRun.findUnique({
      where: { id: runId },
      include: runInclude,
    });
    if (current === null) throw new Error(`Recommendation analysis run not found: ${runId}`);
    if (activeLock.count === 0 && current.status !== 'RUNNING') return current;
    if (activeLock.count === 0 || current.cancelRequestedAt !== null) {
      return current.status === 'CANCELLED'
        ? current
        : tx.recommendationAnalysisRun.update({
            where: { id: runId },
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
            include: runInclude,
          });
    }

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

    if ((input.candidateAudits?.length ?? 0) > 0) {
      await tx.recommendationAnalysisCandidateAudit.createMany({
        data: input.candidateAudits!.map((item) => ({
          tenantId: item.tenantId,
          runId,
          candidateId: item.candidateId,
          draftIndex: item.draftIndex,
          ...(item.recommendationId === undefined ? {} : { recommendationId: item.recommendationId }),
          ...(item.deterministicEvidence === undefined ? {} : { deterministicEvidence: item.deterministicEvidence as Prisma.InputJsonValue }),
          ...(item.draft === undefined ? {} : { draft: item.draft as Prisma.InputJsonValue }),
          auditVerdict: item.auditVerdict,
          auditScore: item.auditScore,
          auditChecks: item.auditChecks as unknown as Prisma.InputJsonValue,
          blockingIssues: item.blockingIssues as unknown as Prisma.InputJsonValue,
          requiredChanges: item.requiredChanges as unknown as Prisma.InputJsonValue,
          repairAttempt: item.repairAttempt,
          finalDisposition: item.finalDisposition,
          ...(item.model === undefined ? {} : { model: item.model }),
          ...(item.auditorModel === undefined ? {} : { auditorModel: item.auditorModel }),
          ...(item.promptHash === undefined ? {} : { promptHash: item.promptHash }),
          ...(item.evidenceHash === undefined ? {} : { evidenceHash: item.evidenceHash }),
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
        cancelRequestedAt: null,
      },
      include: runInclude,
    });
  });
}
