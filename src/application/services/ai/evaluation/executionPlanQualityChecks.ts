import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../../domain/models/FinOpsRecommendation.js';
import { isRecord } from '../jsonReadHelpers.js';
import { collectText, looksLikeSpanish } from '../aiLanguageGuard.js';
import { buildNoSensitiveOutputCheck } from './qualitySensitiveOutput.js';
import { containsUnsafeExecutionPayload } from './unsafeExecutionPayload.js';
import { toReport, type QualityCheck, type QualityReport } from './qualityRubricTypes.js';

const autoExecutionPhrases = [
  'ejecutara automaticamente',
  'ejecutará automáticamente',
  'remediacion automatica',
  'remediación automática',
  'aplicare el cambio automaticamente',
  'sin intervencion manual',
  'sin intervención manual',
];

export function evaluateExecutionPlan(
  plan: Record<string, unknown>,
  snapshot: CostAnalyticsSnapshot,
  recommendation?: FinOpsRecommendation,
): QualityReport {
  const allowedAccounts = new Set(snapshot.accounts.map((account) => account.cloudAccountId));
  const requiredArrays = ['prerequisites', 'steps', 'validation', 'risks', 'rollback', 'successCriteria'];
  const checks: QualityCheck[] = [];

  const arraysOk = requiredArrays.every((field) => (
    Array.isArray(plan[field]) && (plan[field] as unknown[]).length > 0
  ));
  checks.push({
    name: 'requiredArrays',
    passed: arraysOk,
    detail: arraysOk
      ? 'El plan incluye prerrequisitos, pasos, validación, riesgos, rollback y criterios.'
      : 'Faltan secciones obligatorias del plan o están vacías.',
  });

  const scope = isRecord(plan['scope']) ? plan['scope'] : {};
  const scopeAccount = typeof scope['cloudAccountId'] === 'string' ? scope['cloudAccountId'] : '';
  const scopeOk = allowedAccounts.has(scopeAccount);
  checks.push({
    name: 'scopeAccount',
    passed: scopeOk,
    detail: scopeOk ? 'El alcance apunta a una cuenta del snapshot.' : 'El alcance no referencia una cuenta válida.',
  });

  checks.push({
    name: 'recommendationScope',
    passed: matchesRecommendationScope(scope, recommendation),
    detail: matchesRecommendationScope(scope, recommendation)
      ? 'El plan no contradice la cuenta o recurso de la recomendación objetivo.'
      : 'El plan contradice la cuenta o el recurso canónico de la recomendación objetivo.',
  });

  const noAuto = !containsAutoExecution(plan);
  checks.push({
    name: 'noAutoExecution',
    passed: noAuto,
    detail: noAuto ? 'El plan no promete ejecución automática.' : 'El plan promete ejecución automática (prohibido).',
  });

  const noExecutablePayload = !containsUnsafeExecutionPayload(plan);
  checks.push({
    name: 'noExecutablePayload',
    passed: noExecutablePayload,
    detail: noExecutablePayload
      ? 'El plan no contiene payloads de herramientas, shell, SQL ni código ejecutable.'
      : 'El plan contiene un payload de herramientas, shell, SQL o código ejecutable que debe rechazarse.',
  });

  const spanishPlan = looksLikeSpanish(collectText(plan));
  checks.push({
    name: 'spanishText',
    passed: spanishPlan,
    detail: spanishPlan
      ? 'El plan contiene señales suficientes de español.'
      : 'El plan no contiene señales suficientes de español.',
  });

  checks.push(buildNoSensitiveOutputCheck(plan, 'plan'));

  return toReport(checks);
}

function matchesRecommendationScope(
  scope: Record<string, unknown>,
  recommendation: FinOpsRecommendation | undefined,
): boolean {
  if (recommendation === undefined) return true;

  const scopeAccountId = readScopeString(scope, 'cloudAccountId');
  if (scopeAccountId !== undefined && scopeAccountId !== recommendation.cloudAccountId) {
    return false;
  }

  const scopeCloudResourceId = readScopeString(scope, 'cloudResourceId');
  if (scopeCloudResourceId !== undefined && scopeCloudResourceId !== recommendation.cloudResourceId) {
    return false;
  }

  const scopeExternalResourceId = readScopeString(scope, 'externalResourceId')
    ?? readScopeString(scope, 'resourceId');
  const recommendationExternalResourceId = isRecord(recommendation.evidence)
    ? readStringEvidence(recommendation.evidence, 'externalResourceId')
    : undefined;
  return scopeExternalResourceId === undefined
    || scopeExternalResourceId === recommendationExternalResourceId;
}

function readScopeString(scope: Record<string, unknown>, field: string): string | undefined {
  const value = scope[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readStringEvidence(evidence: Record<string, unknown>, field: string): string | undefined {
  const value = evidence[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function containsAutoExecution(plan: Record<string, unknown>): boolean {
  const haystack = JSON.stringify(plan).toLowerCase();
  return autoExecutionPhrases.some((phrase) => haystack.includes(phrase));
}
