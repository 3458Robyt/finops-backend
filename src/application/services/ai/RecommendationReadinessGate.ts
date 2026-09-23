import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  RecommendationEvidenceResource,
  RecommendationEvidenceSnapshot,
} from './RecommendationEvidenceSnapshot.js';

export type RecommendationReadiness = 'GENERATABLE' | 'VALIDATION_ONLY' | 'BLOCKED_NO_EVIDENCE';

export interface RecommendationOpportunityCandidate {
  readonly id: string;
  readonly readiness: RecommendationReadiness;
  readonly cloudAccountId: string;
  readonly provider: string;
  readonly serviceName: string;
  readonly resourceId?: string;
  readonly resourceName?: string;
  readonly cloudResourceId?: string;
  readonly cloudConnectionId?: string;
  readonly opportunityType: string;
  readonly evidenceLevelAllowed: 'COST_ONLY' | 'COST_AND_USAGE' | 'COST_USAGE_AND_TECHNICAL';
  readonly requiresTechnicalValidation: boolean;
  /** Costo observado que limita el candidato; no es ahorro. */
  readonly observedCost?: number;
  readonly maxEstimatedMonthlySavings: number;
  readonly currency: string;
  readonly sourceFacts: readonly string[];
  /** Referencias agregadas canónicas a la fuente FOCUS/costos usada por el candidato. */
  readonly costEvidenceRefs: readonly string[];
  readonly technicalEvidenceRefs: readonly string[];
  readonly evidenceStrength?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Permite distinguir una revisión financiera de una validación técnica. */
  readonly reviewScope?: 'FINANCIAL' | 'TECHNICAL';
  readonly ruleMatches?: readonly string[];
  readonly blockers?: readonly string[];
  readonly metricSummary?: unknown;
  readonly reasons: readonly string[];
  readonly forbiddenClaims: readonly string[];
}

export interface RecommendationReadinessReport {
  readonly candidates: readonly RecommendationOpportunityCandidate[];
  readonly blocked: readonly RecommendationOpportunityCandidate[];
  readonly deferred: readonly RecommendationOpportunityCandidate[];
  readonly summary: string;
}

const maxCandidates = 6;
const standardMonthDays = 30;

export function buildRecommendationReadinessReport(input: {
  readonly snapshot: CostAnalyticsSnapshot;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
}): RecommendationReadinessReport {
  const accountById = new Map(input.snapshot.accounts.map((account) => [account.cloudAccountId, account]));
  const evidenceResources = input.technicalEvidenceSnapshot?.resources ?? [];

  const prioritized = [
    ...buildUsageCandidates(input.snapshot, accountById),
    ...buildResourceCandidates(input.snapshot, accountById, evidenceResources),
    ...buildServiceCandidates(input.snapshot, accountById),
  ]
    .sort((left, right) => right.maxEstimatedMonthlySavings - left.maxEstimatedMonthlySavings);

  // Los candidatos bloqueados se informan aparte y no consumen el cupo de
  // generación: una oportunidad ambigua no debe ocultar otra que sí pueda
  // auditarse.
  const eligible = prioritized.filter((candidate) => candidate.readiness !== 'BLOCKED_NO_EVIDENCE');
  const batch = eligible.slice(0, maxCandidates);
  const deferred = eligible.slice(maxCandidates).map((candidate) => ({
    ...candidate,
    reasons: [...candidate.reasons, 'Aplazado porque existen candidatos de mayor impacto en este lote.'],
  }));
  const allowed = batch;
  const blocked = prioritized.filter((candidate) => candidate.readiness === 'BLOCKED_NO_EVIDENCE');

  return {
    candidates: allowed,
    blocked,
    deferred,
    summary:
      allowed.length === 0
        ? 'No hay candidatos suficientes para generar recomendaciones auditables.'
        : `Hay ${allowed.length} candidatos auditables${deferred.length > 0 ? ` y ${deferred.length} aplazados para otro lote` : ''}: ${allowed
            .map((candidate) => `${candidate.id}:${candidate.readiness}`)
            .join(', ')}.`,
  };
}

export function formatRecommendationReadinessForPrompt(report: RecommendationReadinessReport): string {
  return JSON.stringify(
    {
      instructions: [
        'Solo puedes generar recomendaciones basadas en candidates.',
        'No generes recomendaciones para candidatos BLOCKED_NO_EVIDENCE.',
        'Si readiness es VALIDATION_ONLY, la recomendacion debe pedir validacion tecnica y no debe afirmar ahorro tecnico probado.',
        'estimatedMonthlySavings no puede superar maxEstimatedMonthlySavings.',
      'Debes copiar sourceFacts y technicalEvidenceRefs relevantes en evidence.',
      ],
      summary: report.summary,
      candidates: report.candidates.map(compactCandidate),
      blocked: report.blocked.map(compactCandidate),
    },
    null,
    2,
  );
}

function compactCandidate(candidate: RecommendationOpportunityCandidate): Readonly<Record<string, unknown>> {
  const { metricSummary: _metricSummary, ...compact } = candidate;
  return compact;
}

function buildUsageCandidates(
  snapshot: CostAnalyticsSnapshot,
  accountById: ReadonlyMap<string, { readonly cloudAccountId: string; readonly provider: string }>,
): RecommendationOpportunityCandidate[] {
  return (snapshot.topUsage ?? []).map((usage, index) => {
    const account = pickAccountForProvider(snapshot, accountById, usage.provider);
    return {
      id: `usage-${index + 1}`,
      readiness: 'BLOCKED_NO_EVIDENCE',
      cloudAccountId: account.cloudAccountId,
      provider: usage.provider,
      serviceName: usage.serviceName,
      opportunityType: 'USAGE_OPTIMIZATION',
      evidenceLevelAllowed: 'COST_AND_USAGE',
      requiresTechnicalValidation: false,
      reviewScope: 'FINANCIAL',
      observedCost: usage.totalCost,
      // Cost/quantity evidence identifies spend, not waste or an achievable reduction.
      maxEstimatedMonthlySavings: 0,
      currency: usage.currency,
      sourceFacts: [
        `Servicio ${usage.serviceName} consumio ${usage.consumedQuantity} ${usage.consumedUnit}.`,
        `Costo observado del consumo: ${usage.totalCost} ${usage.currency}.`,
        `Costo mensual normalizado: ${round(normalizeMonthlyAmount(usage.totalCost, snapshot))} ${usage.currency}.`,
        `Costo unitario observado: ${usage.unitCost ?? 'no disponible'} ${usage.currency}/${usage.consumedUnit}.`,
      ],
      costEvidenceRefs: [costEvidenceRef(snapshot, 'usage', usage.provider, usage.serviceName)],
      technicalEvidenceRefs: [],
      reasons: ['El costo y la cantidad facturados describen consumo, pero sin una alternativa tarifada, línea base o regla de desperdicio no demuestran ahorro posible.'],
      forbiddenClaims: ['No presentes el mayor consumo como desperdicio ni cuantifiques ahorro sin comparar una alternativa verificable.'],
    };
  });
}

function buildResourceCandidates(
  snapshot: CostAnalyticsSnapshot,
  accountById: ReadonlyMap<string, { readonly cloudAccountId: string; readonly provider: string }>,
  evidenceResources: readonly RecommendationEvidenceResource[],
): RecommendationOpportunityCandidate[] {
  return snapshot.topResources.map((resource, index) => {
    const providerAccounts = snapshot.accounts.filter((account) => account.provider === resource.provider);
    const account = resource.cloudAccountId !== undefined
      ? accountById.get(resource.cloudAccountId)
      : providerAccounts.length === 1
        ? providerAccounts[0]
        : undefined;
    const resourceEvidence = evidenceResources.filter((item) =>
      item.externalResourceId === resource.resourceId && item.provider === resource.provider,
    );
    const matchingEvidence = resource.cloudResourceId === undefined
      ? resourceEvidence
      : resourceEvidence.filter((item) => item.cloudResourceId === resource.cloudResourceId);
    const connectionMatchedEvidence = resource.cloudConnectionId === undefined
      ? matchingEvidence
      : matchingEvidence.filter((item) => item.cloudConnectionId === resource.cloudConnectionId);
    const identityAmbiguous = account === undefined
      || (resource.cloudResourceId === undefined && resourceEvidence.length > 1)
      || (resource.cloudResourceId !== undefined && resourceEvidence.length > 0 && matchingEvidence.length === 0)
      || (resource.cloudConnectionId !== undefined && matchingEvidence.length > 0 && connectionMatchedEvidence.length === 0);
    const evidenceAmbiguous = connectionMatchedEvidence.length > 1;
    const ambiguous = identityAmbiguous || evidenceAmbiguous;
    const evidenceResource = connectionMatchedEvidence.length === 1 ? connectionMatchedEvidence[0] : undefined;
    const linkedCloudResourceId = resource.cloudResourceId ?? evidenceResource?.cloudResourceId;
    const linkedCloudConnectionId = resource.cloudConnectionId ?? evidenceResource?.cloudConnectionId;
    const identityReason = account === undefined
      ? 'El recurso no tiene una cuenta cloud inequívoca en el snapshot.'
      : resource.cloudResourceId !== undefined && matchingEvidence.length === 0 && resourceEvidence.length > 0
        ? 'El cloudResourceId del costo no coincide con la evidencia técnica disponible.'
        : resource.cloudConnectionId !== undefined && matchingEvidence.length > 0 && connectionMatchedEvidence.length === 0
          ? 'La conexión cloud del costo no coincide con la evidencia técnica disponible.'
        : 'El identificador externo coincide con más de un recurso/conexión; se requiere el cloudResourceId canónico.';
    const resolvedAccountId = account?.cloudAccountId ?? resource.cloudAccountId ?? 'unknown-account';
    const ruleEvaluation = evidenceResource?.ruleEvaluation;
    const refsForResource = evidenceResource?.metrics.map((metric) => metric.evidenceRef) ?? [];
    const hasResourceTechnicalEvidence =
      evidenceResource?.linkQuality === 'COST_AND_TECHNICAL' && refsForResource.length > 0;
    const readiness = ambiguous
      ? 'BLOCKED_NO_EVIDENCE'
      : ruleEvaluation?.readiness ?? (hasResourceTechnicalEvidence ? 'GENERATABLE' : 'VALIDATION_ONLY');
    const normalizedMonthlyCost = normalizeMonthlyAmount(resource.totalCost, snapshot);

    return {
      id: `resource-${index + 1}`,
      readiness,
      cloudAccountId: resolvedAccountId,
      provider: resource.provider,
      serviceName: resource.serviceName,
      resourceId: resource.resourceId,
      ...(resource.resourceName !== undefined && resource.resourceName.trim() !== ''
        ? { resourceName: resource.resourceName }
        : {}),
      ...(linkedCloudResourceId === undefined ? {} : { cloudResourceId: linkedCloudResourceId }),
      ...(linkedCloudConnectionId === undefined ? {} : { cloudConnectionId: linkedCloudConnectionId }),
      opportunityType: ruleEvaluation?.recommendedActionType ?? (hasResourceTechnicalEvidence ? 'TECHNICAL_OPTIMIZATION' : 'TECHNICAL_VALIDATION_REQUIRED'),
      evidenceLevelAllowed:
        readiness === 'GENERATABLE' && hasResourceTechnicalEvidence ? 'COST_USAGE_AND_TECHNICAL' : 'COST_ONLY',
      requiresTechnicalValidation: readiness !== 'GENERATABLE' || hasResourceTechnicalEvidence,
      observedCost: resource.totalCost,
      // Technical utilization rules identify a review/action class, not the target SKU or its price.
      maxEstimatedMonthlySavings: 0,
      currency: snapshot.currency,
      sourceFacts: [
        `Recurso ${resource.resourceName ?? resource.resourceId} (${resource.resourceId}) en ${resource.serviceName}.`,
        `Costo observado del recurso: ${resource.totalCost} ${snapshot.currency}.`,
        `Costo mensual normalizado: ${round(normalizedMonthlyCost)} ${snapshot.currency}.`,
        `Cantidad de registros FOCUS asociados: ${resource.metricCount}.`,
        ...(ruleEvaluation?.sourceFacts ?? []),
      ],
      costEvidenceRefs: [costEvidenceRef(snapshot, 'resource', resource.provider, resource.resourceId, resolvedAccountId)],
      technicalEvidenceRefs: ruleEvaluation?.technicalEvidenceRefs ?? refsForResource,
      ...(ruleEvaluation?.evidenceStrength !== undefined ? { evidenceStrength: ruleEvaluation.evidenceStrength } : {}),
      ...(ruleEvaluation?.ruleMatches !== undefined ? { ruleMatches: ruleEvaluation.ruleMatches } : {}),
      ...(ruleEvaluation?.blockers !== undefined ? { blockers: ruleEvaluation.blockers } : {}),
      ...(ruleEvaluation?.metricSummary !== undefined ? { metricSummary: ruleEvaluation.metricSummary } : {}),
      reasons:
        ambiguous
          ? [identityReason]
          : ruleEvaluation?.blockers !== undefined && ruleEvaluation.blockers.length > 0
          ? [`Reglas deterministicas detectaron bloqueos: ${ruleEvaluation.blockers.join(', ')}.`]
          : hasResourceTechnicalEvidence
            ? ['Hay evidencia tecnica enlazada al recurso y reglas deterministicas compatibles.']
            : ['Hay costo por recurso, pero falta evidencia tecnica fuerte para ejecutar cambios de capacidad.'],
      forbiddenClaims:
        ambiguous
          ? ['No afirmes evidencia técnica ni propongas cambios ejecutables mientras la identidad del recurso sea ambigua.']
          : ruleEvaluation?.blockers !== undefined && ruleEvaluation.blockers.length > 0
          ? ['No recomiendes rightsizing, apagado o resize como accion ejecutable porque existen bloqueos tecnicos.']
          : hasResourceTechnicalEvidence
            ? ['No extrapoles metricas tecnicas fuera de las referencias citadas.']
            : ['No recomiendes rightsizing, apagado o resize como accion ejecutable; pide validacion tecnica previa.'],
    };
  });
}

function buildServiceCandidates(
  snapshot: CostAnalyticsSnapshot,
  accountById: ReadonlyMap<string, { readonly cloudAccountId: string; readonly provider: string }>,
): RecommendationOpportunityCandidate[] {
  return snapshot.services.map((service, index) => {
    const account = pickAccountForProvider(snapshot, accountById, service.provider);
    return {
      id: `service-${index + 1}`,
      // Service spend alone is descriptive; no savings basis exists without a priced alternative.
      readiness: 'BLOCKED_NO_EVIDENCE',
      cloudAccountId: account.cloudAccountId,
      provider: service.provider,
      serviceName: service.serviceName,
      opportunityType: 'SERVICE_COST_REVIEW',
      evidenceLevelAllowed: 'COST_ONLY',
      requiresTechnicalValidation: false,
      reviewScope: 'FINANCIAL',
      observedCost: service.totalCost,
      // A service-level bill has no defensible savings amount without a priced alternative.
      maxEstimatedMonthlySavings: 0,
      currency: snapshot.currency,
      sourceFacts: [
        `Servicio ${service.serviceName} costo ${service.totalCost} ${snapshot.currency}.`,
        `Costo mensual normalizado: ${round(normalizeMonthlyAmount(service.totalCost, snapshot))} ${snapshot.currency}.`,
        `Cantidad de registros FOCUS asociados: ${service.metricCount}.`,
      ],
      costEvidenceRefs: [costEvidenceRef(snapshot, 'service', service.provider, service.serviceName)],
      technicalEvidenceRefs: [],
      reasons: ['El costo agregado identifica gasto, pero no demuestra desperdicio ni ahorro sin una oportunidad de precio/capacidad calculable.'],
      forbiddenClaims: ['No presentes concentración de costo como ahorro ni propongas una reducción sin evidencia calculada.'],
    };
  });
}

function pickAccountForProvider(
  snapshot: CostAnalyticsSnapshot,
  accountById: ReadonlyMap<string, { readonly cloudAccountId: string; readonly provider: string }>,
  provider: string,
): { readonly cloudAccountId: string; readonly provider: string } {
  return (
    snapshot.accounts.find((account) => account.provider === provider) ??
    [...accountById.values()][0] ?? { cloudAccountId: 'unknown-account', provider }
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function getRecommendationPeriodDays(snapshot: CostAnalyticsSnapshot): number {
  const start = new Date(snapshot.periodStart).getTime();
  const end = new Date(snapshot.periodEnd).getTime();
  const elapsedDays = (end - start) / (24 * 60 * 60 * 1000);
  return Number.isFinite(elapsedDays) && elapsedDays > 0
    ? elapsedDays
    : snapshot.coveredDays !== undefined && Number.isFinite(snapshot.coveredDays) && snapshot.coveredDays > 0
      ? snapshot.coveredDays
      : standardMonthDays;
}

function normalizeMonthlyAmount(amount: number, snapshot: CostAnalyticsSnapshot): number {
  return amount * standardMonthDays / getRecommendationPeriodDays(snapshot);
}

/**
 * Identificador estable de evidencia agregada de costos. No es un ID de fila:
 * representa la consulta FOCUS/cost_metrics delimitada por período y alcance,
 * por lo que puede auditarse sin enviar al modelo datos crudos innecesarios.
 */
function costEvidenceRef(
  snapshot: CostAnalyticsSnapshot,
  scope: 'usage' | 'resource' | 'service',
  provider: string,
  key: string,
  cloudAccountId?: string,
): string {
  return `cost_metrics:aggregate:${snapshot.periodStart}:${snapshot.periodEnd}:${scope}:${provider}:${cloudAccountId ?? 'unknown-account'}:${key}`;
}
