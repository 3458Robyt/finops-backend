import { FinOpsBaseError } from '../../../../domain/errors/errors.js';
import { parseRecommendationDrafts } from '../finOpsAiResponseParser.js';
import type { GoldenOutcome, GoldenScenario } from './goldenScenarios.js';
import { evaluateRecommendationDrafts, type QualityReport } from './qualityRubric.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Runner offline de escenarios dorados
 * ═══════════════════════════════════════════════════════════════
 *
 * Ejecuta un escenario dorado sin llamar al modelo: pasa la respuesta
 * "scripteada" por el pipeline real de parsing ({@link parseRecommendationDrafts})
 * y, si supera el parseo, por la rúbrica determinista
 * ({@link evaluateRecommendationDrafts}). Clasifica el resultado y lo compara con
 * el desenlace esperado del escenario. Es completamente determinista, apto para
 * pruebas de regresión de la calidad del agente.
 *
 * @module application/services/ai/evaluation/goldenScenarioRunner
 */

/** Resultado de ejecutar un escenario dorado de forma offline. */
export interface ScenarioResult {
  readonly name: string;
  /** Desenlace observado al pasar por parsing + rúbrica. */
  readonly outcome: GoldenOutcome;
  /** `true` si el desenlace coincide con el esperado por el escenario. */
  readonly matchedExpectation: boolean;
  /** Reporte de la rúbrica cuando el parseo tuvo éxito; `null` si fue rechazado. */
  readonly rubric: QualityReport | null;
}

/**
 * Ejecuta un escenario dorado de forma offline (sin LLM).
 *
 * - Si el parser rechaza la respuesta (lanza `AI_RESPONSE_ERROR` porque no quedan
 *   borradores válidos), el desenlace es `PARSE_REJECTED`.
 * - Si el parser acepta, se aplica la rúbrica: `PARSED_AND_PASSED` si todos los
 *   controles pasan, `PARSED_BUT_FAILED` en caso contrario.
 *
 * @param scenario Escenario dorado a ejecutar.
 * @returns Resultado con el desenlace, si coincide con lo esperado y la rúbrica.
 */
export function runScenarioOffline(scenario: GoldenScenario): ScenarioResult {
  let rubric: QualityReport | null = null;
  let outcome: GoldenOutcome;

  try {
    const drafts = parseRecommendationDrafts(scenario.scriptedRecommendationResponse, scenario.snapshot);
    rubric = evaluateRecommendationDrafts(
      drafts,
      scenario.snapshot,
      undefined,
      scenario.scopedExternalResourceId,
    );
    outcome = rubric.passed ? 'PARSED_AND_PASSED' : 'PARSED_BUT_FAILED';
  } catch (error: unknown) {
    if (error instanceof FinOpsBaseError && error.code === 'AI_RESPONSE_ERROR') {
      outcome = 'PARSE_REJECTED';
    } else {
      throw error;
    }
  }

  return {
    name: scenario.name,
    outcome,
    matchedExpectation: outcome === scenario.expectedOutcome,
    rubric,
  };
}
