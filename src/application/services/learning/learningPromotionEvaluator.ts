import { goldenScenarios } from '../ai/evaluation/goldenScenarios.js';
import { runScenarioOffline } from '../ai/evaluation/goldenScenarioRunner.js';
import type { SimilarLearningPatternCount } from '../../../domain/interfaces/IAgentLearningRepository.js';
import type {
  GlobalLearningCanaryArmEvidence,
  GlobalLearningCanaryEvidence,
} from '../../../domain/models/AgentLearning.js';
import type { MemoryCandidate } from './learningMemoryContent.js';

/** Resultado persistible de la evaluación de un candidato GLOBAL. */
export interface LearningPromotionEvaluation {
  readonly mode: 'OFFLINE_GOLDEN_SAFETY_GATE';
  readonly passed: boolean;
  readonly readyForPromotion: boolean;
  readonly auditScore: number;
  readonly eventCount: number;
  readonly tenantCount: number;
  readonly goldenScenarioCount: number;
  readonly goldenScenarioPassed: number;
  readonly failedGoldenScenarios: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly promotionBlockers: readonly string[];
  readonly evaluatedAt: string;
}

/** Resultado auditable de la comparación live con y sin un candidato GLOBAL. */
export interface GlobalLearningCanaryEvaluation {
  readonly passed: boolean;
  readonly safetyPassed: boolean;
  readonly qualityImproved: boolean;
  readonly noDegradation: boolean;
  readonly blockers: readonly string[];
  readonly evaluatedAt: string;
}

/**
 * Evalúa evidencia live antes de permitir activar aprendizaje transversal.
 *
 * La función es deliberadamente estricta: ambos brazos deben producir salidas
 * auditadas, sin ahorros negativos ni salidas inválidas; el brazo candidato no
 * puede perder puntuación ni aprobaciones y debe demostrar una mejora estricta
 * de calidad. La función no llama al proveedor ni persiste nada.
 */
export function evaluateGlobalLearningCanary(
  evidence: GlobalLearningCanaryEvidence,
): GlobalLearningCanaryEvaluation {
  const blockers: string[] = [];
  if (evidence.mode !== 'LIVE_COMPARATIVE_CANARY') blockers.push('El canary no tiene el modo comparativo requerido.');
  if (evidence.runId.trim() === '') blockers.push('El canary no tiene identificador de ejecución.');
  if (evidence.candidateMemoryId.trim() === '') blockers.push('El canary no identifica la memoria candidata.');

  validateArm('baseline', evidence.baseline, blockers);
  validateArm('candidate', evidence.candidate, blockers);

  const noDegradation = evidence.candidate.qualityScore >= evidence.baseline.qualityScore
    && evidence.candidate.approvedRecommendationCount >= evidence.baseline.approvedRecommendationCount
    && evidence.candidate.recommendationCount >= evidence.baseline.recommendationCount
    && evidence.candidate.invalidOutputCount === 0
    && evidence.candidate.nonNegativeSavings;
  if (!noDegradation) blockers.push('El candidato degrada al menos una métrica de calidad o seguridad.');

  const safetyPassed = blockers.length === 0;

  const qualityImproved = evidence.candidate.qualityScore > evidence.baseline.qualityScore
    || evidence.candidate.approvedRecommendationCount > evidence.baseline.approvedRecommendationCount;
  if (!qualityImproved) blockers.push('El candidato no demuestra una mejora estricta frente a la línea base.');

  return {
    passed: safetyPassed && qualityImproved,
    safetyPassed,
    qualityImproved,
    noDegradation,
    blockers,
    evaluatedAt: new Date().toISOString(),
  };
}

function validateArm(
  name: 'baseline' | 'candidate',
  arm: GlobalLearningCanaryArmEvidence,
  blockers: string[],
): void {
  if (arm.recommendationCount <= 0) blockers.push(`El brazo ${name} no generó recomendaciones comparables.`);
  if (arm.approvedRecommendationCount !== arm.recommendationCount) blockers.push(`El brazo ${name} contiene recomendaciones no aprobadas por auditoría.`);
  if (arm.invalidOutputCount > 0) blockers.push(`El brazo ${name} contiene salidas inválidas.`);
  if (!arm.nonNegativeSavings) blockers.push(`El brazo ${name} contiene ahorro negativo.`);
  if (!Number.isFinite(arm.qualityScore) || arm.qualityScore < 0 || arm.qualityScore > 100) blockers.push(`El score del brazo ${name} está fuera de rango.`);
  if (!Number.isFinite(arm.tokenEstimate) || arm.tokenEstimate < 0) blockers.push(`El consumo de tokens del brazo ${name} no es válido.`);
  if (!Number.isFinite(arm.latencyMs) || arm.latencyMs < 0) blockers.push(`La latencia del brazo ${name} no es válida.`);
}

/**
 * Evalúa un candidato global antes de que pueda entrar al contexto del agente.
 *
 * Esta compuerta es deliberadamente conservadora: valida anonimización,
 * muestra mínima, auditoría y regresión de los escenarios dorados. No afirma
 * una mejora causal del modelo; la promoción real requiere un canary live
 * aislado y una comparación de calidad con y sin el candidato.
 */
export function evaluateGlobalLearningCandidate(input: {
  readonly candidate: MemoryCandidate;
  readonly auditScore: number;
  readonly patternCount: SimilarLearningPatternCount;
  /** Evidencia de un canary live aislado comparando calidad con/sin memoria. */
  readonly qualityEvidenceAvailable?: boolean;
}): LearningPromotionEvaluation {
  const blockingReasons: string[] = [];
  if (input.auditScore < 90) blockingReasons.push('La puntuación del auditor es inferior a 90.');
  if (input.patternCount.eventCount < 5) blockingReasons.push('La muestra no alcanza cinco eventos similares.');
  if (input.patternCount.tenantCount < 2) blockingReasons.push('La muestra no abarca dos tenants distintos.');
  if (containsTenantSpecificData(input.candidate)) {
    blockingReasons.push('El candidato contiene datos identificables o referencias de alcance tenant.');
  }

  const failedGoldenScenarios: string[] = [];
  for (const scenario of goldenScenarios) {
    try {
      const result = runScenarioOffline(scenario);
      if (!result.matchedExpectation) failedGoldenScenarios.push(scenario.name);
    } catch {
      // Una fixture rota debe bloquear la promoción global, no el aprendizaje LOCAL.
      failedGoldenScenarios.push(scenario.name);
    }
  }
  if (failedGoldenScenarios.length > 0) {
    blockingReasons.push('Los escenarios dorados presentan una regresión.');
  }

  const passed = blockingReasons.length === 0;
  const promotionBlockers = input.qualityEvidenceAvailable === true
    ? []
    : ['Aún no existe evidencia de canary live que demuestre mejora sin degradación.'];
  return {
    mode: 'OFFLINE_GOLDEN_SAFETY_GATE',
    passed,
    readyForPromotion: passed && promotionBlockers.length === 0,
    auditScore: input.auditScore,
    eventCount: input.patternCount.eventCount,
    tenantCount: input.patternCount.tenantCount,
    goldenScenarioCount: goldenScenarios.length,
    goldenScenarioPassed: goldenScenarios.length - failedGoldenScenarios.length,
    failedGoldenScenarios,
    blockingReasons,
    promotionBlockers,
    evaluatedAt: new Date().toISOString(),
  };
}

function containsTenantSpecificData(candidate: MemoryCandidate): boolean {
  const serialized = JSON.stringify({ content: candidate.content, metadata: candidate.metadata }).toLowerCase();
  const forbiddenKeys = [
    'tenantid',
    'cloudaccountid',
    'cloudresourceid',
    'externalresourceid',
    'resource_metric_samples',
  ];
  return forbiddenKeys.some((key) => serialized.includes(key));
}
