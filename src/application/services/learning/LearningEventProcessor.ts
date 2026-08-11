import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type {
  IAgentLearningRepository,
  CreateAgentMemoryInput,
  QueuedAgentLearningEvent,
} from '../../../domain/interfaces/IAgentLearningRepository.js';
import type {
  RecommendationLearningResult,
} from '../../../domain/interfaces/IAgentLearningService.js';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import { buildMemoryCandidate, type MemoryCandidate } from './learningMemoryContent.js';
import { isExternalAiLearningFailure, parseAuditReport } from './learningAuditParser.js';
import { buildLearningAuditRequest } from './learningAuditPrompt.js';
import { buildGlobalMemoryInput, buildLocalMemoryInput } from './memoryInputBuilder.js';

const approvedAuditVerdict = 'APPROVED';
const learningRetryBaseMs = 30_000;
const learningRetryMaxMs = 5 * 60_000;

interface LearningEventProcessorOptions {
  readonly recommendationRepository: IRecommendationRepository;
  readonly learningRepository: IAgentLearningRepository;
  readonly aiGateway: IAiGateway;
  readonly auditorModel: string;
  readonly learningAuditTimeoutMs: number;
  readonly truncate: (value: string, maxChars: number) => string;
}

/**
 * Ejecuta el ciclo auditable de un evento ya reclamado de la cola.
 *
 * El servicio de alto nivel conserva el encolado, el contexto y el lease del
 * worker; este colaborador se concentra en auditoría, memoria y reintentos.
 */
export class LearningEventProcessor {
  constructor(private readonly options: LearningEventProcessorOptions) {}

  public async process(
    event: QueuedAgentLearningEvent,
    workerId?: string,
  ): Promise<RecommendationLearningResult> {
    const recommendation = await this.options.recommendationRepository.findById(
      event.tenantId,
      event.recommendationId,
    );

    if (recommendation === null) {
      await this.options.learningRepository.completeEvent({
        eventId: event.id,
        status: 'ERROR',
        errorMessage: 'Recommendation not found for queued learning',
      });
      return { status: 'ERROR', eventId: event.id, error: 'Recommendation not found for queued learning' };
    }

    try {
      const candidate = buildMemoryCandidate(event, recommendation, this.options.truncate);
      const request = buildLearningAuditRequest(candidate, {
        model: this.options.auditorModel,
        timeoutMs: this.options.learningAuditTimeoutMs,
      });
      const auditReport = parseAuditReport(await this.options.aiGateway.generateText(request));

      if (auditReport.verdict !== approvedAuditVerdict || auditReport.score < 80) {
        await this.options.learningRepository.completeEvent({
          eventId: event.id,
          status: 'REJECTED',
          auditVerdict: auditReport.verdict,
          auditScore: auditReport.score,
          auditReport,
          errorMessage: auditReport.blockingIssues.join('\n') || 'Learning candidate rejected by auditor',
        });
        return { status: 'REJECTED', eventId: event.id };
      }

      const localMemory = buildLocalMemoryInput(event.tenantId, event.id, candidate, auditReport);
      const globalMemory = await this.buildGlobalMemoryIfEligible(event, recommendation, candidate, auditReport);
      await this.options.learningRepository.recordApprovedLearning({
        eventId: event.id,
        auditVerdict: auditReport.verdict,
        auditScore: auditReport.score,
        auditReport,
        memories: globalMemory === null ? [localMemory] : [localMemory, globalMemory],
      });
      return { status: 'APPROVED', eventId: event.id };
    } catch (error: unknown) {
      return this.handleFailure(event, workerId, error);
    }
  }

  private async buildGlobalMemoryIfEligible(
    event: QueuedAgentLearningEvent,
    recommendation: FinOpsRecommendation,
    candidate: MemoryCandidate,
    auditReport: AiAuditReport,
  ): Promise<CreateAgentMemoryInput | null> {
    if (auditReport.score < 90) return null;

    const count = await this.options.learningRepository.countSimilarApprovedEvents({
      reasonCode: event.reasonCode,
      recommendationType: recommendation.type,
      decision: event.decision,
    });
    if (count.eventCount < 5 || count.tenantCount < 2) return null;

    const fingerprint = `GLOBAL:${candidate.fingerprint}`;
    if (await this.options.learningRepository.hasActiveGlobalMemory(fingerprint)) return null;

    return buildGlobalMemoryInput(
      event,
      recommendation,
      candidate,
      auditReport,
      event.id,
      count,
      this.options.truncate,
    );
  }

  private async handleFailure(
    event: QueuedAgentLearningEvent,
    workerId: string | undefined,
    error: unknown,
  ): Promise<RecommendationLearningResult> {
    const externalFailure = isExternalAiLearningFailure(error);
    const errorMessage = error instanceof Error ? error.message : 'Learning processing failed';

    if (externalFailure && workerId !== undefined) {
      const status = await this.options.learningRepository.releaseEventForRetry({
        eventId: event.id,
        workerId,
        errorMessage,
        nextAttemptAt: new Date(Date.now() + retryDelayMs(event.attempts)),
      });
      return { status, eventId: event.id, error: errorMessage };
    }

    const status = externalFailure ? 'SKIPPED' : 'ERROR';
    await this.options.learningRepository.completeEvent({ eventId: event.id, status, errorMessage });
    return { status, eventId: event.id, error: errorMessage };
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(learningRetryMaxMs, learningRetryBaseMs * (2 ** Math.max(0, attempt - 1)));
}
