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
  readonly opportunityType: string;
  readonly evidenceLevelAllowed: 'COST_ONLY' | 'COST_AND_USAGE' | 'COST_USAGE_AND_TECHNICAL';
  readonly requiresTechnicalValidation: boolean;
  readonly maxEstimatedMonthlySavings: number;
  readonly currency: string;
  readonly sourceFacts: readonly string[];
  readonly technicalEvidenceRefs: readonly string[];
  readonly evidenceStrength?: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly ruleMatches?: readonly string[];
  readonly blockers?: readonly string[];
  readonly metricSummary?: unknown;
  readonly reasons: readonly string[];
  readonly forbiddenClaims: readonly string[];
}

export interface RecommendationReadinessReport {
  readonly candidates: readonly RecommendationOpportunityCandidate[];
  readonly blocked: readonly RecommendationOpportunityCandidate[];
  readonly summary: string;
}

const maxCandidates = 6;
const costSavingsRate = 0.18;
const usageSavingsRate = 0.12;
const technicalSavingsRate = 0.25;

export function buildRecommendationReadinessReport(input: {
  readonly snapshot: CostAnalyticsSnapshot;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
}): RecommendationReadinessReport {
  const accountById = new Map(input.snapshot.accounts.map((account) => [account.cloudAccountId, account]));
  const evidenceByResource = new Map(
    (input.technicalEvidenceSnapshot?.resources ?? []).map((resource) => [resource.externalResourceId, resource]),
  );

  const candidates = [
    ...buildUsageCandidates(input.snapshot, accountById),
    ...buildResourceCandidates(input.snapshot, accountById, evidenceByResource),
    ...buildServiceCandidates(input.snapshot, accountById),
  ]
    .sort((left, right) => right.maxEstimatedMonthlySavings - left.maxEstimatedMonthlySavings)
    .slice(0, maxCandidates);

  const allowed = candidates.filter((candidate) => candidate.readiness !== 'BLOCKED_NO_EVIDENCE');
  const blocked = candidates.filter((candidate) => candidate.readiness === 'BLOCKED_NO_EVIDENCE');

  return {
    candidates: allowed,
    blocked,
    summary:
      allowed.length === 0
        ? 'No hay candidatos suficientes para generar recomendaciones auditables.'
        : `Hay ${allowed.length} candidatos auditables: ${allowed
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
      ...report,
    },
    null,
    2,
  );
}

function buildUsageCandidates(
  snapshot: CostAnalyticsSnapshot,
  accountById: ReadonlyMap<string, { readonly cloudAccountId: string; readonly provider: string }>,
): RecommendationOpportunityCandidate[] {
  return (snapshot.topUsage ?? []).slice(0, 4).map((usage, index) => {
    const account = pickAccountForProvider(snapshot, accountById, usage.provider);
    return {
      id: `usage-${index + 1}`,
      readiness: 'GENERATABLE',
      cloudAccountId: account.cloudAccountId,
      provider: usage.provider,
      serviceName: usage.serviceName,
      opportunityType: 'USAGE_OPTIMIZATION',
      evidenceLevelAllowed: 'COST_AND_USAGE',
      requiresTechnicalValidation: false,
      maxEstimatedMonthlySavings: round(Math.max(usage.totalCost * usageSavingsRate, 0)),
      currency: usage.currency,
      sourceFacts: [
        `Servicio ${usage.serviceName} consumio ${usage.consumedQuantity} ${usage.consumedUnit}.`,
        `Costo observado del consumo: ${usage.totalCost} ${usage.currency}.`,
        `Costo unitario observado: ${usage.unitCost ?? 'no disponible'} ${usage.currency}/${usage.consumedUnit}.`,
      ],
      technicalEvidenceRefs: [],
      reasons: ['Existe consumo facturado FOCUS con unidad y costo unitario.'],
      forbiddenClaims: ['No afirmes CPU, memoria, IOPS, throughput ni utilizacion tecnica.'],
    };
  });
}

function buildResourceCandidates(
  snapshot: CostAnalyticsSnapshot,
  accountById: ReadonlyMap<string, { readonly cloudAccountId: string; readonly provider: string }>,
  evidenceByResource: ReadonlyMap<string, RecommendationEvidenceResource>,
): RecommendationOpportunityCandidate[] {
  return snapshot.topResources.slice(0, 4).map((resource, index) => {
    const account = pickAccountForProvider(snapshot, accountById, resource.provider);
    const evidenceResource = evidenceByResource.get(resource.resourceId);
    const ruleEvaluation = evidenceResource?.ruleEvaluation;
    const refsForResource = evidenceResource?.metrics.map((metric) => metric.evidenceRef) ?? [];
    const hasResourceTechnicalEvidence =
      evidenceResource?.linkQuality === 'COST_AND_TECHNICAL' && refsForResource.length > 0;
    const readiness = ruleEvaluation?.readiness ?? (hasResourceTechnicalEvidence ? 'GENERATABLE' : 'VALIDATION_ONLY');
    const maxSavingsRate = ruleEvaluation?.maxTechnicalSavingsRate ?? (hasResourceTechnicalEvidence ? technicalSavingsRate : costSavingsRate);

    return {
      id: `resource-${index + 1}`,
      readiness,
      cloudAccountId: account.cloudAccountId,
      provider: resource.provider,
      serviceName: resource.serviceName,
      resourceId: resource.resourceId,
      opportunityType: ruleEvaluation?.recommendedActionType ?? (hasResourceTechnicalEvidence ? 'TECHNICAL_OPTIMIZATION' : 'TECHNICAL_VALIDATION_REQUIRED'),
      evidenceLevelAllowed:
        readiness === 'GENERATABLE' && hasResourceTechnicalEvidence ? 'COST_USAGE_AND_TECHNICAL' : 'COST_ONLY',
      requiresTechnicalValidation: readiness !== 'GENERATABLE',
      maxEstimatedMonthlySavings: round(
        Math.max(resource.totalCost * maxSavingsRate, 0),
      ),
      currency: snapshot.currency,
      sourceFacts: [
        `Recurso ${resource.resourceId} en ${resource.serviceName}.`,
        `Costo observado del recurso: ${resource.totalCost} ${snapshot.currency}.`,
        `Cantidad de registros FOCUS asociados: ${resource.metricCount}.`,
        ...(ruleEvaluation?.sourceFacts ?? []),
      ],
      technicalEvidenceRefs: ruleEvaluation?.technicalEvidenceRefs ?? refsForResource,
      ...(ruleEvaluation?.evidenceStrength !== undefined ? { evidenceStrength: ruleEvaluation.evidenceStrength } : {}),
      ...(ruleEvaluation?.ruleMatches !== undefined ? { ruleMatches: ruleEvaluation.ruleMatches } : {}),
      ...(ruleEvaluation?.blockers !== undefined ? { blockers: ruleEvaluation.blockers } : {}),
      ...(ruleEvaluation?.metricSummary !== undefined ? { metricSummary: ruleEvaluation.metricSummary } : {}),
      reasons:
        ruleEvaluation?.blockers !== undefined && ruleEvaluation.blockers.length > 0
          ? [`Reglas deterministicas detectaron bloqueos: ${ruleEvaluation.blockers.join(', ')}.`]
          : hasResourceTechnicalEvidence
            ? ['Hay evidencia tecnica enlazada al recurso y reglas deterministicas compatibles.']
            : ['Hay costo por recurso, pero falta evidencia tecnica fuerte para ejecutar cambios de capacidad.'],
      forbiddenClaims:
        ruleEvaluation?.blockers !== undefined && ruleEvaluation.blockers.length > 0
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
  return snapshot.services.slice(0, 4).map((service, index) => {
    const account = pickAccountForProvider(snapshot, accountById, service.provider);
    return {
      id: `service-${index + 1}`,
      readiness: service.metricCount > 0 ? 'VALIDATION_ONLY' : 'BLOCKED_NO_EVIDENCE',
      cloudAccountId: account.cloudAccountId,
      provider: service.provider,
      serviceName: service.serviceName,
      opportunityType: 'SERVICE_COST_REVIEW',
      evidenceLevelAllowed: 'COST_ONLY',
      requiresTechnicalValidation: true,
      maxEstimatedMonthlySavings: round(Math.max(service.totalCost * costSavingsRate, 0)),
      currency: snapshot.currency,
      sourceFacts: [
        `Servicio ${service.serviceName} costo ${service.totalCost} ${snapshot.currency}.`,
        `Cantidad de registros FOCUS asociados: ${service.metricCount}.`,
      ],
      technicalEvidenceRefs: [],
      reasons: ['Costo agregado por servicio disponible; requiere analisis tecnico antes de ejecutar cambios.'],
      forbiddenClaims: ['No afirmes metricas tecnicas ni ahorro garantizado.'],
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
