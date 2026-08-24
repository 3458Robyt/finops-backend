import { FinOpsBaseError, AuthorizationError } from '../../../domain/errors/errors.js';
import type { IAgentLearningRepository } from '../../../domain/interfaces/IAgentLearningRepository.js';
import type { AuthContext } from '../../../domain/models/AuthContext.js';
import type { AgentMemory, GlobalLearningCanaryEvidence } from '../../../domain/models/AgentLearning.js';
import { evaluateGlobalLearningCanary } from './learningPromotionEvaluator.js';

/** Promoción manual y auditable de candidatos GLOBAL después de un canary. */
export class GlobalLearningPromotionService {
  public constructor(private readonly repository: IAgentLearningRepository) {}

  /**
   * Activa un candidato GLOBAL únicamente cuando el canary live demuestra una
   * mejora estricta y ausencia de degradación. Solo MASTER_ADMIN puede cruzar
   * esta frontera porque el efecto alcanza a más de un tenant.
   */
  public async promote(input: {
    readonly actor: AuthContext;
    readonly sourceLearningEventId: string;
    readonly evidence: GlobalLearningCanaryEvidence;
  }): Promise<AgentMemory> {
    if (input.actor.role !== 'MASTER_ADMIN') {
      throw new AuthorizationError('Solo el administrador maestro puede promover aprendizaje global.');
    }

    const evaluation = evaluateGlobalLearningCanary(input.evidence);
    if (!evaluation.passed) {
      throw new FinOpsBaseError(
        `El candidato global no supera el canary: ${evaluation.blockers.join(' ')}`,
        'VALIDATION_ERROR',
      );
    }

    const promote = this.repository.promoteGlobalMemoryWithEvidence;
    if (promote === undefined) {
      throw new FinOpsBaseError('La promoción global no está configurada.', 'CONFIGURATION_ERROR');
    }

    const memory = await promote.call(this.repository, {
      sourceLearningEventId: input.sourceLearningEventId,
      actorUserId: input.actor.userId,
      evidence: input.evidence,
    });
    if (memory === null) {
      throw new FinOpsBaseError('El candidato global no existe, ya está activo o no coincide con la evidencia.', 'NOT_FOUND');
    }
    return memory;
  }
}
