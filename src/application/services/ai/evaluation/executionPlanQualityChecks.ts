import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../../domain/models/FinOpsRecommendation.js';
import { isVerifiedSavingsCalculation } from '../../../../domain/models/recommendationEconomics.js';
import { isRecord } from '../jsonReadHelpers.js';
import { collectText, looksLikeSpanish } from '../aiLanguageGuard.js';
import { buildNoSensitiveOutputCheck } from './qualitySensitiveOutput.js';
import { containsUnsafeExecutionPayload } from './unsafeExecutionPayload.js';
import { toReport, type QualityCheck, type QualityReport } from './qualityRubricTypes.js';

const autoExecutionPatterns = [
  /\b(?:el sistema|la plataforma|el asistente|el servicio)\s+(?:ejecutara|ejecutará|aplicara|aplicará|realizara|realizará)\s+(?:el cambio\s+)?automaticamente\b/i,
  /\b(?:ejecutar|aplicar|realizar)\s+(?:el cambio\s+)?automaticamente\b/i,
  /\b(?:ejecutare|ejecutaré|aplicare|aplicaré|realizare|realizaré)\s+(?:el cambio\s+)?automaticamente\b/i,
  /\bsin\s+(?:ninguna\s+)?intervencion\s+manual\b/i,
];

const unconditionedManualOperationPatterns = [
  /\b(?:ejecutar|aplicar|realizar|efectuar)\s+(?:manualmente\s+)?(?:el\s+)?(?:cambio|ajuste|resize|redimensionamiento|apagado|reinicio)\b/i,
  /\b(?:cambiar|reducir|aumentar|redimensionar|detener|terminar|eliminar)\s+(?:directamente\s+)?(?:la\s+)?(?:capacidad|instancia|recurso|servidor|tama[nñ]o)\b/i,
];

const explicitApprovalPattern = /\b(?:si|solo\s+despu[eé]s\s+de|una\s+vez\s+que|previa|bajo)\b[\s\S]{0,90}\b(?:aprobaci[oó]n|autorizaci[oó]n|confirmaci[oó]n)\b/i;
const explicitNegativeOperationPattern = /\b(?:no|nunca|jam[aá]s)\b[\s\S]{0,35}\b(?:ejecutar|aplicar|realizar|cambiar|redimensionar|detener|eliminar)\b/i;
const monetaryPrefixPattern = /\b(USD|COP|EUR|GBP|MXN|BRL|CAD|AUD)\s*([0-9][0-9.,]*)/gi;
const monetarySuffixPattern = /\b([0-9][0-9.,]*)\s*(USD|COP|EUR|GBP|MXN|BRL|CAD|AUD)\b/gi;
const monetarySymbolPattern = /[$€£]\s*([0-9][0-9.,]*)/gu;

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

  const recommendationScopeOk = matchesRecommendationScope(scope, recommendation);
  checks.push({
    name: 'recommendationScope',
    passed: recommendationScopeOk,
    detail: recommendationScopeOk
      ? 'El plan no contradice la cuenta o recurso de la recomendación objetivo.'
      : describeScopeMismatch(scope, recommendation),
  });

  const noAuto = !containsAutoExecution(plan);
  checks.push({
    name: 'noAutoExecution',
    passed: noAuto,
    detail: noAuto ? 'El plan no promete ejecución automática.' : 'El plan promete ejecución automática (prohibido).',
  });

  const noUnconditionedOperation = !containsUnconditionedManualOperation(plan);
  checks.push({
    name: 'manualGovernance',
    passed: noUnconditionedOperation,
    detail: noUnconditionedOperation
      ? 'Las operaciones potenciales están condicionadas a aprobación externa o se expresan como validación.'
      : 'El plan contiene una instrucción operativa no condicionada a aprobación externa.',
  });

  const recommendationStateOk = matchesRecommendationState(plan, recommendation);
  checks.push({
    name: 'recommendationStateConsistency',
    passed: recommendationStateOk,
    detail: recommendationStateOk
      ? 'El plan no confunde el estado de la recomendación con el estado del ahorro.'
      : 'El plan confunde POTENTIAL_NOT_VERIFIED con el estado de gestión de la recomendación.',
  });

  const costProvenanceIssue = findCostProvenanceIssue(plan, recommendation);
  const costProvenanceOk = costProvenanceIssue === undefined;
  checks.push({
    name: 'costProvenance',
    passed: costProvenanceOk,
    detail: costProvenanceIssue
      ?? 'Los importes monetarios del plan coinciden con hechos autorizados de la recomendación.',
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

export function containsAutoExecution(plan: Record<string, unknown>): boolean {
  const haystack = JSON.stringify(plan);
  return autoExecutionPatterns.some((pattern) => pattern.test(haystack));
}

export function containsUnconditionedManualOperation(plan: Record<string, unknown>): boolean {
  const operationalText = collectText({
    steps: plan['steps'],
    validation: plan['validation'],
    rollback: plan['rollback'],
  });

  return operationalText
    .split(/[.!?\n]+/u)
    .some((sentence) => {
      if (!unconditionedManualOperationPatterns.some((pattern) => pattern.test(sentence))) {
        return false;
      }

      return !explicitApprovalPattern.test(sentence) && !explicitNegativeOperationPattern.test(sentence);
    });
}

function matchesRecommendationState(
  plan: Record<string, unknown>,
  recommendation: FinOpsRecommendation | undefined,
): boolean {
  if (recommendation === undefined) return true;

  const text = collectText(plan);
  const incorrectlyReusedSavingsStatus = [
    /\b(?:estado|estatus)\s+(?:de\s+)?(?:gesti[oó]n\s+)?(?:de\s+)?la\s+recomendaci[oó]n\b[\s\S]{0,60}\bPOTENTIAL_NOT_VERIFIED\b/i,
    /\b(?:la\s+recomendaci[oó]n|recomendaci[oó]n\s+original)\b[\s\S]{0,60}\b(?:estado|estatus)\b[\s\S]{0,60}\bPOTENTIAL_NOT_VERIFIED\b/i,
  ].some((pattern) => pattern.test(text));
  return !incorrectlyReusedSavingsStatus;
}

function describeScopeMismatch(
  scope: Record<string, unknown>,
  recommendation: FinOpsRecommendation | undefined,
): string {
  if (recommendation === undefined) return 'El plan contradice la cuenta o el recurso canónico de la recomendación objetivo.';

  const actualAccount = readScopeString(scope, 'cloudAccountId') ?? '(ausente)';
  const actualResource = readScopeString(scope, 'cloudResourceId')
    ?? readScopeString(scope, 'externalResourceId')
    ?? readScopeString(scope, 'resourceId')
    ?? '(ausente)';
  const expectedResource = recommendation.cloudResourceId ?? (
    isRecord(recommendation.evidence)
      ? readStringEvidence(recommendation.evidence, 'externalResourceId') ?? '(sin recurso enlazado)'
      : '(sin recurso enlazado)'
  );
  return `El alcance no coincide. Usa exactamente cloudAccountId=${recommendation.cloudAccountId} y recurso=${expectedResource}; recibió cloudAccountId=${actualAccount} y recurso=${actualResource}.`;
}

function findCostProvenanceIssue(
  plan: Record<string, unknown>,
  recommendation: FinOpsRecommendation | undefined,
): string | undefined {
  if (extractMoneyMentions(collectText(plan)).length > 0) {
    return 'No incluyas montos monetarios en el texto del plan; la evidencia económica pertenece a la recomendación y estimatedSavings debe usar solo el cálculo determinístico.';
  }

  const estimatedSavings = isRecord(plan['estimatedSavings']) ? plan['estimatedSavings'] : undefined;
  const estimatedAmount = typeof estimatedSavings?.['amount'] === 'number'
    ? estimatedSavings['amount']
    : undefined;
  const estimatedCurrency = typeof estimatedSavings?.['currency'] === 'string'
    ? estimatedSavings['currency'].toUpperCase()
    : undefined;

  if (estimatedAmount !== undefined && estimatedAmount > 0) {
    if (recommendation === undefined) {
      return 'No hay una recomendación asociada que autorice el ahorro estructurado del plan.';
    }
    const evidence = isRecord(recommendation.evidence) ? recommendation.evidence : {};
    const calculation = isRecord(evidence['savingsCalculation']) ? evidence['savingsCalculation'] : undefined;
    const verified = isVerifiedSavingsCalculation(
      evidence,
      recommendation.estimatedMonthlySavings,
      recommendation.currency,
    );
    const authorizedAmount = typeof calculation?.['amount'] === 'number' ? calculation['amount'] : undefined;
    if (
      !verified
      || authorizedAmount === undefined
      || estimatedCurrency !== recommendation.currency.toUpperCase()
      || !sameMoney(authorizedAmount, recommendation.currency, estimatedAmount, estimatedCurrency)
    ) {
      return 'El ahorro estructurado no coincide con un cálculo determinístico de alternativa tarifada.';
    }
  }

  return undefined;
}

function extractMoneyMentions(text: string): MonetaryFact[] {
  const mentions: MonetaryFact[] = [];
  for (const match of text.matchAll(monetaryPrefixPattern)) {
    const currency = match[1];
    const amount = parseLocalizedAmount(match[2]);
    if (currency !== undefined && amount !== undefined) mentions.push({ amount, currency });
  }
  for (const match of text.matchAll(monetarySuffixPattern)) {
    const amount = parseLocalizedAmount(match[1]);
    const currency = match[2];
    if (currency !== undefined && amount !== undefined) mentions.push({ amount, currency });
  }
  for (const match of text.matchAll(monetarySymbolPattern)) {
    const amount = parseLocalizedAmount(match[1]);
    if (amount !== undefined) mentions.push({ amount, currency: 'SYMBOL' });
  }
  return mentions;
}

interface MonetaryFact {
  readonly amount: number;
  readonly currency: string;
}

function parseLocalizedAmount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.replace(/\s/gu, '');
  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');
  let value = normalized;

  if (lastComma >= 0 && lastDot >= 0) {
    value = lastComma > lastDot
      ? normalized.replace(/\./gu, '').replace(',', '.')
      : normalized.replace(/,/gu, '');
  } else if (lastComma >= 0) {
    const decimals = normalized.length - lastComma - 1;
    value = decimals === 2 ? normalized.replace(',', '.') : normalized.replace(/,/gu, '');
  } else {
    value = normalized.replace(/,/gu, '');
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sameMoney(
  leftAmount: number,
  leftCurrency: string,
  rightAmount: number,
  rightCurrency: string | undefined,
): boolean {
  return rightCurrency !== undefined
    && leftCurrency.toUpperCase() === rightCurrency.toUpperCase()
    && Math.abs(leftAmount - rightAmount) <= Math.max(0.01, Math.abs(leftAmount) * 0.0001);
}
