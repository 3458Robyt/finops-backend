import type {
  AgentMemoryType,
  RecommendationFeedbackReason,
} from '../../../domain/models/AgentLearning.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { ProcessRecommendationDecisionInput } from '../../../domain/interfaces/IAgentLearningService.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Contenido de memorias de aprendizaje del agente FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que construyen el texto y los metadatos de las "memorias"
 * que el agente aprende a partir de las decisiones humanas: candidatos de
 * memoria LOCAL, contenido de memoria GLOBAL, la traducción de motivos a
 * español y los resúmenes de evidencia.
 *
 * El truncado/compactación se inyecta como parámetro {@link TruncateFn}
 * (típicamente `ContextBudgeter.truncate`) para mantener estas funciones
 * libres de dependencias de instancia y fáciles de probar.
 *
 * @module application/services/learning/learningMemoryContent
 */

/** Función de truncado de texto (p. ej. `ContextBudgeter.truncate`). */
export type TruncateFn = (value: string, maxChars: number) => string;

/** Candidato de memoria de aprendizaje: tipo, contenido, huella y metadatos. */
export interface MemoryCandidate {
  readonly memoryType: AgentMemoryType;
  readonly content: string;
  readonly fingerprint: string;
  readonly metadata: unknown;
}

/**
 * Construye el candidato de memoria a partir de la decisión y la recomendación.
 *
 * Heurística:
 * - Aprobación → memoria de tipo `APPROVAL_PATTERN` (acción "priorizar").
 * - Rechazo → memoria de tipo `REJECTION_PATTERN` (acción "evitar o corregir").
 * - El contenido se redacta en español, incorpora el motivo traducido y el
 *   criterio aprendido, y se trunca a 900 caracteres.
 * - El `fingerprint` (decisión:motivo:tipo) permite deduplicar y agregar
 *   patrones equivalentes entre eventos/tenants.
 *
 * @param input          - Decisión humana sobre la recomendación.
 * @param recommendation - Recomendación evaluada.
 * @param truncate       - Función de truncado de texto inyectada.
 * @returns Candidato con tipo de memoria, contenido, fingerprint y metadatos.
 */
export function buildMemoryCandidate(
  input: ProcessRecommendationDecisionInput,
  recommendation: FinOpsRecommendation,
  truncate: TruncateFn,
): MemoryCandidate {
  const isApproval = input.decision === 'APPROVED';
  const memoryType: AgentMemoryType = isApproval ? 'APPROVAL_PATTERN' : 'REJECTION_PATTERN';
  const action = isApproval ? 'priorizar' : 'evitar o corregir';
  const reason = reasonToSpanish(input.reasonCode);
  const note = input.reason !== undefined ? ` Comentario humano: ${input.reason}` : '';
  const content = [
    `Para recomendaciones FinOps de tipo ${recommendation.type}, ${action} patrones asociados a ${reason}.`,
    `Caso observado: "${recommendation.title}".`,
    `Criterio aprendido: ${learningInstruction(input.reasonCode, recommendation.type)}.${note}`,
  ].join(' ');

  return {
    memoryType,
    content: truncate(content, 900),
    fingerprint: [
      input.decision,
      input.reasonCode,
      recommendation.type,
    ].join(':'),
    metadata: {
      recommendationType: recommendation.type,
      reasonCode: input.reasonCode,
      decision: input.decision,
    },
  };
}

/**
 * Construye el contenido textual de una memoria GLOBAL, enfatizando que
 * debe usarse solo como criterio de calidad y que los datos factuales deben
 * provenir del snapshot actual. Truncado a 700 caracteres.
 */
export function buildGlobalMemoryContent(
  reasonCode: RecommendationFeedbackReason,
  recommendationType: string,
  truncate: TruncateFn,
): string {
  return truncate(
    `Patron global FinOps para ${recommendationType}: ${learningInstruction(reasonCode, recommendationType)}. Usar solo como criterio de calidad; los datos factuales deben venir del snapshot actual.`,
    700,
  );
}

/**
 * Traduce un código de motivo de feedback a la instrucción de aprendizaje
 * concreta (en español) que el agente debe aplicar.
 *
 * Mapea cada {@link RecommendationFeedbackReason} a un criterio accionable;
 * por ejemplo, "evidencia insuficiente" se traduce en no proponer acciones
 * sin métricas, servicio afectado, alcance ni validación técnica.
 *
 * @param reasonCode         - Código de motivo del feedback humano.
 * @param recommendationType - Tipo de recomendación, interpolado en el texto.
 * @returns Instrucción de aprendizaje en español.
 */
export function learningInstruction(reasonCode: RecommendationFeedbackReason, recommendationType: string): string {
  const instructions: Record<RecommendationFeedbackReason, string> = {
    APPROVED_HIGH_CONFIDENCE: `las recomendaciones ${recommendationType} deben incluir evidencia concreta, alcance claro y validacion previa`,
    APPROVED_LOW_RISK_QUICK_WIN: `priorizar acciones reversibles, de bajo riesgo y con beneficio operativo claro`,
    REJECTED_INSUFFICIENT_EVIDENCE: `no proponer acciones sin metricas, servicio afectado, alcance y validacion tecnica suficiente`,
    REJECTED_SAVINGS_UNREALISTIC: `evitar ahorros estimados que no esten soportados por costo observado y supuestos verificables`,
    REJECTED_OPERATIONAL_RISK: `explicar riesgo operativo, prerequisitos y rollback antes de recomendar ejecucion`,
    REJECTED_BUSINESS_EXCEPTION: `considerar excepciones de negocio antes de repetir el mismo patron`,
    REJECTED_ALREADY_HANDLED: `verificar si la accion ya fue implementada o esta en curso antes de recomendarla`,
    REJECTED_WRONG_SCOPE: `validar cuenta, servicio, ambiente y recurso antes de generar la recomendacion`,
    REJECTED_NOT_ACTIONABLE: `convertir recomendaciones genericas en pasos concretos con evidencia y criterio de exito`,
  };

  return instructions[reasonCode];
}

/**
 * Convierte un código de motivo (p. ej. `REJECTED_WRONG_SCOPE`) a una frase
 * legible en español, en minúsculas y con guiones bajos reemplazados por espacios.
 */
export function reasonToSpanish(reasonCode: RecommendationFeedbackReason): string {
  return reasonCode.toLowerCase().replaceAll('_', ' ');
}

/**
 * Resume la evidencia de una recomendación para almacenarla en el evento.
 *
 * Serializa la evidencia a JSON y la trunca a 1200 caracteres; si no hay
 * evidencia, devuelve un texto indicativo.
 */
export function summarizeEvidence(evidence: unknown, truncate: TruncateFn): string {
  if (evidence === null || evidence === undefined) {
    return 'Sin evidencia adicional registrada.';
  }

  return truncate(JSON.stringify(evidence), 1200);
}
