import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';

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

interface DeterministicRuleEvaluation {
  readonly readiness: RecommendationReadiness;
  readonly evidenceStrength?: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly recommendedActionType?: string;
  readonly ruleMatches?: readonly string[];
  readonly blockers?: readonly string[];
  readonly sourceFacts?: readonly string[];
  readonly technicalEvidenceRefs?: readonly string[];
  readonly metricSummary?: unknown;
  readonly maxTechnicalSavingsRate?: number;
}

export function buildRecommendationReadinessReport(input: {
  readonly snapshot: CostAnalyticsSnapshot;
  readonly technicalEvidence?: string;
}): RecommendationReadinessReport {
  const accountById = new Map(input.snapshot.accounts.map((account) => [account.cloudAccountId, account]));
  const technicalRefs = extractTechnicalEvidenceRefs(input.technicalEvidence);
  const deterministicRules = extractDeterministicRules(input.technicalEvidence);
  const hasStrongTechnicalEvidence = technicalRefs.length > 0;

  const candidates = [
    ...buildUsageCandidates(input.snapshot, accountById),
    ...buildResourceCandidates(input.snapshot, accountById, technicalRefs, deterministicRules, hasStrongTechnicalEvidence),
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
  technicalRefs: readonly string[],
  deterministicRules: ReadonlyMap<string, DeterministicRuleEvaluation>,
  hasStrongTechnicalEvidence: boolean,
): RecommendationOpportunityCandidate[] {
  return snapshot.topResources.slice(0, 4).map((resource, index) => {
    const account = pickAccountForProvider(snapshot, accountById, resource.provider);
    const refsForResource = technicalRefs.filter((ref) => ref.includes(resource.resourceId));
    const ruleEvaluation = deterministicRules.get(resource.resourceId);
    const hasResourceTechnicalEvidence =
      ruleEvaluation?.readiness === 'GENERATABLE' ||
      (hasStrongTechnicalEvidence && refsForResource.length > 0);
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

function extractTechnicalEvidenceRefs(technicalEvidence: string | undefined): string[] {
  if (technicalEvidence === undefined || technicalEvidence.trim() === '') {
    return [];
  }

  const refs = new Set<string>();
  for (const match of technicalEvidence.matchAll(/resource_metric_samples:[^"',\]\s]+/g)) {
    refs.add(match[0]);
  }

  return [...refs];
}

function extractDeterministicRules(
  technicalEvidence: string | undefined,
): ReadonlyMap<string, DeterministicRuleEvaluation> {
  if (technicalEvidence === undefined || technicalEvidence.trim() === '') {
    return new Map();
  }

  const jsonStart = technicalEvidence.indexOf('{');
  if (jsonStart < 0) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(technicalEvidence.slice(jsonStart)) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed['deterministicRules'])) {
      return new Map();
    }

    const entries = parsed['deterministicRules']
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item): readonly [string, DeterministicRuleEvaluation] | null => {
        const externalResourceId = readString(item, 'externalResourceId');
        const readiness = readReadiness(item['readiness']);
        if (externalResourceId === undefined || readiness === undefined) {
          return null;
        }

        const evidenceStrength = readEvidenceStrength(item['evidenceStrength']);
        const recommendedActionType = readString(item, 'recommendedActionType');

        return [
          externalResourceId,
          {
            readiness,
            ...(evidenceStrength !== undefined ? { evidenceStrength } : {}),
            ...(recommendedActionType !== undefined ? { recommendedActionType } : {}),
            ruleMatches: readStringArray(item['ruleMatches']),
            blockers: readStringArray(item['blockers']),
            sourceFacts: readStringArray(item['sourceFacts']),
            technicalEvidenceRefs: readStringArray(item['technicalEvidenceRefs']),
            ...(item['metricSummary'] !== undefined ? { metricSummary: item['metricSummary'] } : {}),
            ...(typeof item['maxTechnicalSavingsRate'] === 'number'
              ? { maxTechnicalSavingsRate: item['maxTechnicalSavingsRate'] }
              : {}),
          },
        ];
      })
      .filter((entry): entry is readonly [string, DeterministicRuleEvaluation] => entry !== null);

    return new Map(entries);
  } catch {
    return new Map();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function readReadiness(value: unknown): RecommendationReadiness | undefined {
  return value === 'GENERATABLE' || value === 'VALIDATION_ONLY' || value === 'BLOCKED_NO_EVIDENCE'
    ? value
    : undefined;
}

function readEvidenceStrength(value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
