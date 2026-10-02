import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { RecommendationCostEvidenceScope } from '../../../domain/interfaces/IRecommendationRepository.js';
import type {
  RecommendationEvidenceResource,
  RecommendationEvidenceSnapshot,
} from './RecommendationEvidenceSnapshot.js';
import type { VerifiedSavingsCalculation } from '../../../domain/models/recommendationEconomics.js';
import { sourceDiagnosticIssue, technicalBlockerAction } from './recommendationEvidenceDiagnostics.js';
import { selectTechnicalReviewCandidates } from './recommendationReviewCandidateSelection.js';
import { normalizeMonthlyAmount } from './recommendationReadinessSupport.js';
export { getRecommendationPeriodDays } from './recommendationReadinessSupport.js';

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
  /** Deterministic server-side comparison against a priced alternative; never model-authored. */
  readonly savingsCalculation?: VerifiedSavingsCalculation;
  readonly maxEstimatedMonthlySavings: number;
  readonly currency: string;
  readonly sourceFacts: readonly string[];
  /** Referencias agregadas canónicas a la fuente FOCUS/costos usada por el candidato. */
  readonly costEvidenceRefs: readonly string[];
  readonly costEvidenceScope?: RecommendationCostEvidenceScope;
  readonly technicalEvidenceRefs: readonly string[];
  readonly evidenceStrength?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Permite distinguir una revisión financiera de una validación técnica. */
  readonly reviewScope?: 'FINANCIAL' | 'TECHNICAL';
  readonly ruleMatches?: readonly string[];
  readonly blockers?: readonly string[];
  readonly metricSummary?: unknown;
  readonly reasons: readonly string[];
  readonly evidenceIssues?: readonly { readonly code: string; readonly action: string }[];
  readonly evidencePeriod?: Readonly<{ readonly costStart: string; readonly costEnd: string; readonly lastMetricAt?: string }>;
  readonly forbiddenClaims: readonly string[];
}

export interface RecommendationReadinessReport {
  readonly candidates: readonly RecommendationOpportunityCandidate[];
  readonly blocked: readonly RecommendationOpportunityCandidate[];
  readonly deferred: readonly RecommendationOpportunityCandidate[];
  /** Recurso con costo vigente y vínculo no ambiguo que puede producir solo un borrador de revisión. */
  readonly reviewCandidates?: readonly RecommendationOpportunityCandidate[];
  readonly summary: string;
}

const maxCandidates = 6;
export function buildRecommendationReadinessReport(input: {
  readonly snapshot: CostAnalyticsSnapshot;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
}): RecommendationReadinessReport {
  const accountById = new Map(input.snapshot.accounts.map((account) => [account.cloudAccountId, account]));
  const evidenceResources = input.technicalEvidenceSnapshot?.resources ?? [];
  const prioritized = [
    ...buildUsageCandidates(input.snapshot),
    ...buildResourceCandidates(input.snapshot, accountById, evidenceResources,
      input.technicalEvidenceSnapshot?.generatedAt, input.technicalEvidenceSnapshot?.sourceDiagnostics ?? [],
      input.technicalEvidenceSnapshot?.summaryTruncated === true),
    ...buildServiceCandidates(input.snapshot),
  ]
    .sort((left, right) => right.maxEstimatedMonthlySavings - left.maxEstimatedMonthlySavings);

  // Solo reglas determinísticas GENERATABLE llegan al LLM. VALIDATION_ONLY y
  // BLOCKED se muestran como faltantes de evidencia, nunca como recomendaciones.
  const eligible = prioritized.filter((candidate) => candidate.readiness === 'GENERATABLE');
  const batch = eligible.slice(0, maxCandidates);
  const deferred = eligible.slice(maxCandidates).map((candidate) => ({
    ...candidate,
    reasons: [...candidate.reasons, 'Aplazado porque existen candidatos de mayor impacto en este lote.'],
  }));
  const allowed = batch;
  const blocked = prioritized.filter((candidate) => candidate.readiness !== 'GENERATABLE');
  const reviewCandidates = selectTechnicalReviewCandidates(blocked, input.snapshot);

  return {
    candidates: allowed,
    blocked,
    deferred,
    reviewCandidates,
    summary:
      allowed.length === 0
        ? reviewCandidates.length > 0
          ? `No hay recomendaciones publicables con la evidencia actual. Se pueden preparar hasta ${reviewCandidates.length} borradores de revisión técnica, sin ahorro cuantificado ni autorización operativa.`
          : 'No hay oportunidades con evidencia determinística suficiente para generar recomendaciones auditables.'
        : `Hay ${allowed.length} candidatos auditables${deferred.length > 0 ? ` y ${deferred.length} aplazados para otro lote` : ''}: ${allowed
            .map((candidate) => `${candidate.id}:${candidate.readiness}`)
            .join(', ')}.`,
  };
}

export function formatRecommendationReadinessForPrompt(report: RecommendationReadinessReport): string {
  return JSON.stringify(
    {
      instructions: [
        'Solo puedes generar recomendaciones basadas en candidates; los candidatos blocked y deferred no están autorizados para generación.',
        'No generes recomendaciones para readiness VALIDATION_ONLY o BLOCKED_NO_EVIDENCE; espera a que la evidencia determinística los habilite.',
        'No inventes ahorros; estimatedMonthlySavings solo puede copiar amount de savingsCalculation generado por el servidor y debe reconciliar con su evidencia y maxEstimatedMonthlySavings.',
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
  const { metricSummary: _metricSummary, costEvidenceScope: _costEvidenceScope, evidenceIssues: _evidenceIssues,
    evidencePeriod: _evidencePeriod, ...compact } = candidate;
  return compact;
}

function buildUsageCandidates(
  snapshot: CostAnalyticsSnapshot,
): RecommendationOpportunityCandidate[] {
  return (snapshot.topUsage ?? []).map((usage, index) => {
    const account = findUniqueAccountForProvider(snapshot, usage.provider);
    const accountScopeReason = account === undefined
      ? 'El análisis agregado no identifica una cuenta cloud única para este proveedor.'
      : undefined;
    return {
      id: `usage-${index + 1}`,
      readiness: 'BLOCKED_NO_EVIDENCE',
      cloudAccountId: account?.cloudAccountId ?? 'unknown-account',
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
      costEvidenceRefs: [costEvidenceRef(snapshot, 'usage', usage.provider, usage.serviceName, account?.cloudAccountId)],
      technicalEvidenceRefs: [],
      reasons: [
        ...(accountScopeReason === undefined ? [] : [accountScopeReason]),
        'El costo y la cantidad facturados describen consumo, pero sin una alternativa tarifada, línea base o regla de desperdicio no demuestran ahorro posible.',
      ],
      forbiddenClaims: [
        'No presentes el mayor consumo como desperdicio ni cuantifiques ahorro sin comparar una alternativa verificable.',
        ...(accountScopeReason === undefined ? [] : ['No atribuyas este gasto a una cuenta cloud mientras su alcance sea ambiguo.']),
      ],
    };
  });
}

function buildResourceCandidates(
  snapshot: CostAnalyticsSnapshot,
  accountById: ReadonlyMap<string, { readonly cloudAccountId: string; readonly provider: string }>,
  evidenceResources: readonly RecommendationEvidenceResource[],
  generatedAt?: string,
  sourceDiagnostics: NonNullable<RecommendationEvidenceSnapshot['sourceDiagnostics']> = [],
  summaryTruncated = false,
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
      evidenceResource?.linkQuality === 'COST_AND_TECHNICAL'
      && linkedCloudResourceId !== undefined && refsForResource.length > 0;
    const observedThrough = new Date(snapshot.observedThrough ?? snapshot.periodEnd);
    const analysisAt = new Date(generatedAt ?? Date.now());
    const costStale = Number.isFinite(observedThrough.getTime()) && Number.isFinite(analysisAt.getTime())
      && analysisAt.getTime() - observedThrough.getTime() > 7 * 86400000;
    const noChargeableCost = !Number.isFinite(resource.totalCost) || resource.totalCost <= 0;
    const readiness = ambiguous
      ? 'BLOCKED_NO_EVIDENCE'
      : costStale || noChargeableCost || !hasResourceTechnicalEvidence || summaryTruncated
        ? 'VALIDATION_ONLY'
        : ruleEvaluation?.readiness ?? 'VALIDATION_ONLY';
    const normalizedMonthlyCost = normalizeMonthlyAmount(resource.totalCost, snapshot);
    const lastMetricAt = evidenceResource?.metrics
      .map((metric) => metric.latestSampledAt).sort().at(-1);
    const evidenceIssues = [
      ...(costStale ? [{ code: 'STALE_COST', action: 'Actualizar la ingesta FOCUS o Usage API antes de recomendar.' }] : []),
      ...(noChargeableCost ? [{ code: 'NO_CHARGEABLE_COST', action: 'No hay costo positivo atribuible al recurso en este período. Verificar FOCUS/Usage API y el vínculo al inventario; no proyectar ahorro.' }] : []),
      ...(summaryTruncated ? [{ code: 'EVIDENCE_QUERY_LIMIT_REACHED', action: 'El catálogo técnico superó el límite de series para este análisis. Acotar el recurso/scope y repetir la vista previa; no generar con evidencia parcial.' }] : []),
      ...(ambiguous ? [{ code: 'AMBIGUOUS_RESOURCE_LINK', action: 'Revisar el vínculo exacto entre costo, inventario y métricas.' }] : []),
      ...(!hasResourceTechnicalEvidence ? [{ code: 'NO_LINKED_TECHNICAL_METRICS', action: 'Descubrir CPU y memoria de esta instancia en OCI y comprobar su vínculo al inventario.' }] : []),
      ...sourceDiagnostics
        .filter((item) => item.externalResourceId === resource.resourceId
          && item.cloudConnectionId === resource.cloudConnectionId
          && !evidenceResource?.metrics.some((metric) => metric.metricName.toLowerCase() === item.metricName.toLowerCase()))
        .map((item) => sourceDiagnosticIssue(item)),
      ...(ruleEvaluation?.blockers ?? []).map((code) => ({ code, action: technicalBlockerAction(code) })),
      ...(readiness === 'GENERATABLE' ? [{ code: 'UNPRICED_ALTERNATIVE', action: 'Identificar una configuración alternativa y verificar su tarifa antes de cuantificar ahorro.' }] : []),
    ];

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
      ...(readiness === 'GENERATABLE'
        && linkedCloudResourceId !== undefined
        && resolvedAccountId !== 'unknown-account'
        ? {
            costEvidenceScope: {
              provider: resource.provider as RecommendationCostEvidenceScope['provider'],
              cloudAccountId: resolvedAccountId,
              cloudResourceId: linkedCloudResourceId,
              resourceId: resource.resourceId,
              serviceName: resource.serviceName,
              expectedMetricCount: resource.metricCount,
              ...(linkedCloudConnectionId === undefined ? {} : { cloudConnectionId: linkedCloudConnectionId }),
              periodStart: snapshot.periodStart,
              periodEnd: snapshot.periodEnd,
            },
          }
        : {}),
      technicalEvidenceRefs: ruleEvaluation?.technicalEvidenceRefs ?? refsForResource,
      evidenceIssues,
      evidencePeriod: {
        costStart: snapshot.periodStart,
        costEnd: snapshot.periodEnd,
        ...(lastMetricAt === undefined ? {} : { lastMetricAt }),
      },
      ...(ruleEvaluation?.evidenceStrength !== undefined ? { evidenceStrength: ruleEvaluation.evidenceStrength } : {}),
      ...(ruleEvaluation?.ruleMatches !== undefined ? { ruleMatches: ruleEvaluation.ruleMatches } : {}),
      ...(ruleEvaluation?.blockers !== undefined ? { blockers: ruleEvaluation.blockers } : {}),
      ...(ruleEvaluation?.metricSummary !== undefined ? { metricSummary: ruleEvaluation.metricSummary } : {}),
      reasons:
        ambiguous
          ? [identityReason]
          : costStale
          ? ['Los costos están desactualizados para una decisión operativa actual.']
          : noChargeableCost
          ? ['El recurso no tiene un costo positivo atribuible en el período analizado.']
          : !hasResourceTechnicalEvidence
          ? ['No hay un vínculo exacto entre el costo y las métricas técnicas del recurso.']
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
): RecommendationOpportunityCandidate[] {
  return snapshot.services.map((service, index) => {
    const account = findUniqueAccountForProvider(snapshot, service.provider);
    const accountScopeReason = account === undefined
      ? 'El análisis agregado no identifica una cuenta cloud única para este proveedor.'
      : undefined;
    return {
      id: `service-${index + 1}`,
      // Service spend alone is descriptive; no savings basis exists without a priced alternative.
      readiness: 'BLOCKED_NO_EVIDENCE',
      cloudAccountId: account?.cloudAccountId ?? 'unknown-account',
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
      costEvidenceRefs: [costEvidenceRef(snapshot, 'service', service.provider, service.serviceName, account?.cloudAccountId)],
      technicalEvidenceRefs: [],
      reasons: [
        ...(accountScopeReason === undefined ? [] : [accountScopeReason]),
        'El costo agregado identifica gasto, pero no demuestra desperdicio ni ahorro sin una oportunidad de precio/capacidad calculable.',
      ],
      forbiddenClaims: [
        'No presentes concentración de costo como ahorro ni propongas una reducción sin evidencia calculada.',
        ...(accountScopeReason === undefined ? [] : ['No atribuyas este gasto a una cuenta cloud mientras su alcance sea ambiguo.']),
      ],
    };
  });
}

function findUniqueAccountForProvider(
  snapshot: CostAnalyticsSnapshot,
  provider: string,
): CostAnalyticsSnapshot['accounts'][number] | undefined {
  const matches = snapshot.accounts.filter((account) => account.provider === provider);
  return matches.length === 1 ? matches[0] : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
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
