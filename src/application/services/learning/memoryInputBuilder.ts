import type { CreateAgentMemoryInput } from '../../../domain/interfaces/IAgentLearningRepository.js';
import type { ProcessRecommendationDecisionInput } from '../../../domain/interfaces/IAgentLearningService.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { SimilarLearningPatternCount } from '../../../domain/interfaces/IAgentLearningRepository.js';
import {
  buildGlobalMemoryContent,
  type MemoryCandidate,
  type TruncateFn,
} from './learningMemoryContent.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Constructores de entrada de memorias del agente FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que ensamblan el {@link CreateAgentMemoryInput} que el
 * servicio persiste tras una auditoría aprobada: la memoria LOCAL de un evento
 * concreto y la memoria GLOBAL promovida desde un patrón recurrente. Mantienen
 * el cálculo de confianza y los metadatos junto al contenido, dejando al
 * servicio solo la coordinación de los repositorios. No importan del servicio,
 * evitando dependencias circulares.
 *
 * @module application/services/learning/memoryInputBuilder
 */

/**
 * Construye la entrada de una memoria LOCAL a partir de un candidato auditado.
 *
 * La confianza se acota al rango 0.7–0.95 en función del score de auditoría,
 * y se conservan el tipo de memoria, contenido, metadatos, fingerprint y el
 * reporte de auditoría tal como los produjo el candidato.
 *
 * @param tenantId    - Tenant propietario de la memoria.
 * @param eventId     - Evento de aprendizaje que origina la memoria.
 * @param candidate   - Candidato de memoria construido a partir del evento.
 * @param auditReport - Reporte de auditoría IA aprobado.
 * @returns La entrada lista para persistir la memoria LOCAL.
 */
export function buildLocalMemoryInput(
  tenantId: string,
  eventId: string,
  candidate: MemoryCandidate,
  auditReport: AiAuditReport,
): CreateAgentMemoryInput {
  return {
    tenantId,
    scope: 'LOCAL',
    memoryType: candidate.memoryType,
    content: candidate.content,
    confidence: Math.min(0.95, Math.max(0.7, auditReport.score / 100)),
    sourceLearningEventId: eventId,
    metadata: candidate.metadata,
    auditVerdict: auditReport.verdict,
    auditScore: auditReport.score,
    auditReport,
    fingerprint: candidate.fingerprint,
  };
}

/**
 * Construye la entrada de una memoria GLOBAL promovida desde un patrón maduro.
 *
 * El contenido se redacta con {@link buildGlobalMemoryContent}, la confianza se
 * acota a un máximo de 0.95 según el score, el fingerprint se prefija con
 * `GLOBAL:` y los metadatos registran la prevalencia (eventos y tenants) que
 * justificó la promoción.
 *
 * @param input       - Decisión humana original (motivo y sentido).
 * @param recommendation - Recomendación evaluada.
 * @param candidate   - Candidato de memoria con el fingerprint base.
 * @param auditReport - Reporte de auditoría IA aprobado.
 * @param eventId     - Evento de aprendizaje que origina la promoción.
 * @param count       - Conteo de eventos y tenants similares que la sustentan.
 * @param truncate    - Función de truncado de texto inyectada.
 * @returns La entrada lista para persistir la memoria GLOBAL.
 */
export function buildGlobalMemoryInput(
  input: ProcessRecommendationDecisionInput,
  recommendation: FinOpsRecommendation,
  candidate: MemoryCandidate,
  auditReport: AiAuditReport,
  eventId: string,
  count: SimilarLearningPatternCount,
  truncate: TruncateFn,
): CreateAgentMemoryInput {
  return {
    scope: 'GLOBAL',
    memoryType: candidate.memoryType,
    content: buildGlobalMemoryContent(input.reasonCode, recommendation.type, truncate),
    confidence: Math.min(0.95, auditReport.score / 100),
    sourceLearningEventId: eventId,
    metadata: {
      recommendationType: recommendation.type,
      reasonCode: input.reasonCode,
      decision: input.decision,
      promotedFromEvents: count.eventCount,
      promotedFromTenants: count.tenantCount,
    },
    auditVerdict: auditReport.verdict,
    auditScore: auditReport.score,
    auditReport,
    fingerprint: `GLOBAL:${candidate.fingerprint}`,
  };
}
