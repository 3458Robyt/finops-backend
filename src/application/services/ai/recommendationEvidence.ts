import type { AgentLearningContext } from '../../../domain/interfaces/IAgentLearningService.js';
import type { CreateRecommendationInput } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import { isRecord } from './jsonReadHelpers.js';

/**
 * Enriquecimiento de evidencia de los borradores de recomendación generados por IA.
 *
 * Función pura que combina la evidencia original del borrador con el reporte de
 * auditoría IA y, cuando existe, el contexto de aprendizaje auditado utilizado.
 * Se aísla del servicio para mantenerlo enfocado en la orquestación.
 *
 * @module application/services/ai/recommendationEvidence
 */

/**
 * Enriquece un borrador con la evidencia de auditoría y, si existe, el
 * contexto de aprendizaje usado.
 *
 * @param draft - Borrador de recomendación (con `tenantId`) generado por la IA.
 * @param auditReport - Reporte del auditor IA a anexar como `aiAudit`.
 * @param learningContext - Contexto de aprendizaje; se anexa como `aiLearning`
 *   solo cuando su `summary` no está vacío.
 * @returns Input de creación de recomendación con la evidencia enriquecida.
 */
export function applyAuditEvidence(
  draft: AiRecommendationDraft & { tenantId: string },
  auditReport: AiAuditReport,
  learningContext: AgentLearningContext,
): CreateRecommendationInput {
  return {
    ...draft,
    evidence: {
      ...(isRecord(draft.evidence) ? draft.evidence : {}),
      aiAudit: auditReport,
      ...(learningContext.summary !== ''
        ? {
            aiLearning: {
              memoryIds: learningContext.memoryIds,
              caseIds: learningContext.caseIds,
              summary: learningContext.summary,
            },
          }
        : {}),
    },
  };
}
