import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type {
  RecommendationOpportunityCandidate,
  RecommendationReadinessReport,
} from './RecommendationReadinessGate.js';
import { isRecord } from './jsonReadHelpers.js';
import { isVerifiedSavingsCalculation } from '../../../domain/models/recommendationEconomics.js';

/**
 * Normaliza borradores generados por el modelo contra los candidatos y el
 * snapshot técnico determinista. El modelo puede proponer texto, pero no puede
 * ampliar la evidencia ni cambiar la clasificación de seguridad del candidato.
 */
export function normalizeRecommendationDrafts(
  drafts: readonly AiRecommendationDraft[],
  readinessReport: RecommendationReadinessReport | undefined,
  technicalEvidenceSnapshot: RecommendationEvidenceSnapshot | undefined,
  cloudResourceId?: string,
  periodDays?: number,
): readonly AiRecommendationDraft[] {
  if (readinessReport === undefined) return [];

  return drafts
    .filter((draft) => findCandidate(draft, readinessReport.candidates) !== undefined)
    .map((draft) => {
    const candidate = findCandidate(draft, readinessReport.candidates);
    if (candidate === undefined) {
      return stripUnverifiedSavings(draft);
    }

    const existingEvidence = isRecord(draft.evidence) ? draft.evidence : {};
    const technicalResource = candidate.resourceId === undefined || technicalEvidenceSnapshot === undefined
      ? undefined
      : technicalEvidenceSnapshot.resources.find((resource) =>
        resource.externalResourceId === candidate.resourceId
        && (cloudResourceId === undefined || resource.cloudResourceId === cloudResourceId)
        && (candidate.cloudResourceId === undefined || resource.cloudResourceId === candidate.cloudResourceId),
      );
    const primaryMetric = technicalResource?.metrics.find((metric) => /cpu|memory/i.test(metric.metricName))
      ?? technicalResource?.metrics[0];
    const resourceCandidate = candidate.resourceId !== undefined;
    const financialReviewOnly = candidate.reviewScope === 'FINANCIAL'
      && candidate.resourceId === undefined;
    const hasCapacityBlocker = technicalResource?.ruleEvaluation.blockers.some((blocker) =>
      blocker === 'CPU_SATURATION_RISK' || blocker === 'MEMORY_SATURATION_RISK',
    ) === true;
    const technicalReviewOnly = technicalResource !== undefined && (
      candidate.opportunityType === 'PERFORMANCE_CAPACITY_REVIEW'
      || isCapacityAction(candidate.opportunityType)
      || isCapacityAction(draft.type)
      || hasCapacityBlocker
    );
    const technicalValidationOnly = resourceCandidate && (
      candidate.readiness !== 'GENERATABLE'
      || technicalResource === undefined
      || technicalResource.ruleEvaluation.blockers.length > 0
    );
    const withoutStaleTechnicalFields = technicalResource !== undefined
      || candidate.resourceId === undefined
      || technicalValidationOnly
      ? removeTechnicalEvidenceFields(existingEvidence)
      : existingEvidence;
    const safeGeneratedEvidence = removeGeneratedSafetyAndCostFields(withoutStaleTechnicalFields);
    // The readiness gate is authoritative. The model may not upgrade a
    // cost/usage candidate into a technical-validation candidate by emitting
    // a conflicting flag in its draft.
    const requiresTechnicalValidation = candidate.requiresTechnicalValidation
      || technicalResource !== undefined
      || technicalValidationOnly;
    const resourceIdentifier = technicalResource?.externalResourceId ?? candidate.resourceId;
    const displayResourceIdentifier = displayResourceName(candidate, technicalResource);
    const safeType = technicalReviewOnly
      ? 'PERFORMANCE_CAPACITY_REVIEW'
      : technicalValidationOnly
        ? 'TECHNICAL_VALIDATION_REQUIRED'
      : candidate.opportunityType;
    const safeTitle = technicalReviewOnly && displayResourceIdentifier !== undefined
      ? `Revisar capacidad y rendimiento de ${displayResourceIdentifier}`
      : technicalValidationOnly && displayResourceIdentifier !== undefined
        ? `Validar señales técnicas de ${displayResourceIdentifier}`
      : technicalResource !== undefined
        ? [
            draft.description,
            'La validación técnica y la aprobación manual son obligatorias; esta recomendación no autoriza por sí sola resize, apagado ni otro cambio operativo.',
          ].join(' ')
        : candidate.resourceId === undefined
          ? `Revisar costo y consumo de ${candidate.serviceName}`
        : draft.title;
    const safeDescription = technicalReviewOnly && displayResourceIdentifier !== undefined
      ? [
          `Revisar la capacidad y el rendimiento del recurso ${displayResourceIdentifier}.`,
          'La evidencia permite priorizar una revisión previa. Esta salida es informativa, no es una autorización ni un plan de ejecución. La validación y aprobación manual son obligatorias antes de cualquier cambio operativo.',
        ].join(' ')
      : technicalValidationOnly && displayResourceIdentifier !== undefined
        ? [
            `Validar las señales técnicas y el enlace de inventario del recurso ${displayResourceIdentifier}.`,
            technicalResource === undefined
              ? 'No hay evidencia técnica enlazada y reciente suficiente para afirmar utilización o recomendar un cambio operativo; confirma el recurso y sus métricas en Monitoring antes de actuar.'
              : 'La evidencia técnica disponible requiere validación adicional antes de cualquier cambio operativo.',
            'Esta salida es informativa, no propone un cambio operativo ni autoriza su ejecución. La aprobación manual es obligatoria.',
          ].join(' ')
      : candidate.resourceId === undefined
        ? [
            candidate.sourceFacts.join(' '),
            'Esta oportunidad usa únicamente costo y consumo facturado FOCUS; no autoriza cambios operativos ni afirma utilización técnica.',
          ].join(' ')
        : draft.description;
    const technicalFields = technicalResource !== undefined && primaryMetric !== undefined
      ? {
          externalResourceId: technicalResource.externalResourceId,
          ...(technicalResource.cloudResourceId !== undefined ? { cloudResourceId: technicalResource.cloudResourceId } : {}),
          technicalEvidenceRefs: technicalResource.metrics.map((metric) => metric.evidenceRef),
          technicalSampleCount: primaryMetric.sampleCount,
          technicalCoverageDays: primaryMetric.coverageDays,
          latestTechnicalSampleAt: primaryMetric.latestSampledAt,
          blockers: technicalResource.ruleEvaluation.blockers,
          ruleMatches: technicalResource.ruleEvaluation.ruleMatches,
          deterministicRules: technicalResource.ruleEvaluation,
          normalizedActionType: technicalReviewOnly ? 'PERFORMANCE_CAPACITY_REVIEW' : candidate.opportunityType,
          focusLimitation: 'FOCUS aporta costo y consumo facturado; las métricas técnicas citadas provienen de Monitoring/CloudWatch y se mantienen separadas.',
        }
      : {};
    const normalizedCloudResourceId = technicalResource?.cloudResourceId ?? candidate.cloudResourceId;
    const { estimatedMonthlySavings: generatedSavings, ...draftWithoutSavings } = draft;
    const calculation = candidate.savingsCalculation;
    const deterministicSavings = calculation !== undefined
      && isVerifiedSavingsCalculation({ savingsCalculation: calculation }, calculation.amount, candidate.currency)
      && calculation.amount <= candidate.maxEstimatedMonthlySavings + 0.01
      ? calculation.amount
      : undefined;
    const hasVerifiedCalculation = deterministicSavings !== undefined;

    return {
      ...draftWithoutSavings,
      cloudAccountId: candidate.cloudAccountId,
      currency: candidate.currency,
      ...(!technicalValidationOnly && !technicalReviewOnly && !financialReviewOnly && deterministicSavings !== undefined
        ? { estimatedMonthlySavings: deterministicSavings }
        : {}),
      ...(normalizedCloudResourceId !== undefined ? { cloudResourceId: normalizedCloudResourceId } : {}),
      ...(normalizedCloudResourceId === undefined && candidate.resourceId !== undefined
        ? { resourceLinkReason: 'INVENTORY_RESOURCE_NOT_FOUND' }
        : {}),
      type: safeType,
      title: safeTitle,
      description: safeDescription,
      evidence: {
        ...safeGeneratedEvidence,
        candidateId: candidate.id,
        ...(resourceIdentifier !== undefined ? { externalResourceId: resourceIdentifier } : {}),
        ...(normalizedCloudResourceId !== undefined ? { cloudResourceId: normalizedCloudResourceId } : {}),
        costEvidenceRefs: candidate.costEvidenceRefs,
        evidenceLevel: candidate.evidenceLevelAllowed,
        evidenceStrength: candidate.evidenceStrength ?? withoutStaleTechnicalFields['evidenceStrength'] ?? 'MEDIUM',
        sourceFacts: technicalReviewOnly
          ? candidate.sourceFacts.filter((fact) => /^(CPU|Memoria)\b/i.test(fact))
          : candidate.sourceFacts,
        requiresTechnicalValidation,
        ...(candidate.observedCost === undefined ? {} : { observedCost: candidate.observedCost }),
        ...(candidate.observedCost === undefined ? {} : {
          normalizedMonthlyCost: round(normalizeMonthlyAmount(candidate.observedCost, periodDays)),
        }),
        maxEstimatedMonthlySavings: deterministicSavings ?? 0,
        ...(hasVerifiedCalculation ? { savingsCalculation: calculation } : {}),
        ...(deterministicSavings !== undefined && (technicalValidationOnly || technicalReviewOnly || financialReviewOnly)
          ? {
              potentialMonthlySavings: deterministicSavings,
              savingsStatus: 'POTENTIAL_NOT_VERIFIED',
            }
          : {}),
        ...(deterministicSavings === undefined && generatedSavings !== undefined && generatedSavings > 0
          ? { savingsStatus: 'UNVERIFIED' }
          : {}),
        readiness: candidate.readiness,
        ...(technicalValidationOnly
          || technicalReviewOnly
          ? {
              technicalReviewOnly: true,
              operationalAuthorization: 'NONE',
              requiresManualValidation: true,
            }
          : {}),
        ...(financialReviewOnly
          ? {
              financialReviewOnly: true,
              reviewScope: 'FINANCIAL',
              operationalAuthorization: 'NONE',
              requiresManualValidation: true,
            }
          : {}),
        ...technicalFields,
      },
    };
  });
}

/** Elimina borradores financieros sin ahorro potencial accionable. */
export function dropNonActionableFinancialDrafts(
  drafts: readonly AiRecommendationDraft[],
  readinessReport: RecommendationReadinessReport | undefined,
): readonly AiRecommendationDraft[] {
  if (readinessReport === undefined) return drafts;
  const candidatesById = new Map(readinessReport.candidates.map((candidate) => [candidate.id, candidate]));
  return drafts.filter((draft) => {
    const evidence = isRecord(draft.evidence) ? draft.evidence : {};
    const candidateId = typeof evidence['candidateId'] === 'string' ? evidence['candidateId'] : undefined;
    const candidate = candidateId === undefined ? undefined : candidatesById.get(candidateId);
    const isUnscopedFinancialReview = candidate?.reviewScope === 'FINANCIAL';
    const calculation = candidate?.savingsCalculation;
    const hasQuantifiableSavings = candidate !== undefined && calculation !== undefined
      && isVerifiedSavingsCalculation({ savingsCalculation: calculation }, calculation.amount, candidate.currency)
      && calculation.amount <= candidate.maxEstimatedMonthlySavings + 0.01;
    const potential = hasQuantifiableSavings ? calculation.amount : undefined;
    return !(isUnscopedFinancialReview && (!hasQuantifiableSavings || (potential ?? 0) <= 0));
    });
}

function stripUnverifiedSavings(draft: AiRecommendationDraft): AiRecommendationDraft {
  const { estimatedMonthlySavings, ...withoutAmount } = draft;
  const evidence = isRecord(draft.evidence) ? removeGeneratedSafetyAndCostFields(draft.evidence) : {};
  return {
    ...withoutAmount,
    evidence: {
      ...evidence,
      ...(estimatedMonthlySavings !== undefined && estimatedMonthlySavings > 0 ? { savingsStatus: 'UNVERIFIED' } : {}),
    },
  };
}

function findCandidate(
  draft: AiRecommendationDraft,
  candidates: readonly RecommendationOpportunityCandidate[],
): RecommendationOpportunityCandidate | undefined {
  const evidence = isRecord(draft.evidence) ? draft.evidence : {};
  const explicitId = typeof evidence['candidateId'] === 'string' ? evidence['candidateId'] : undefined;
  if (explicitId !== undefined) {
    const explicit = candidates.find((candidate) => candidate.id === explicitId);
    if (explicit !== undefined) return explicit;
  }

  const externalResourceId = typeof evidence['externalResourceId'] === 'string'
    ? evidence['externalResourceId']
    : undefined;
  if (externalResourceId !== undefined) {
    const requestedCloudResourceId = typeof evidence['cloudResourceId'] === 'string'
      ? evidence['cloudResourceId']
      : undefined;
    const resource = uniqueCandidate(candidates, (candidate) =>
      candidate.resourceId === externalResourceId
      && (requestedCloudResourceId === undefined || candidate.cloudResourceId === requestedCloudResourceId),
    );
    if (resource !== undefined) return resource;
  }

  const normalizedType = draft.type.toUpperCase();
  const exact = uniqueCandidate(candidates, (candidate) => candidate.opportunityType.toUpperCase() === normalizedType);
  if (exact !== undefined) return exact;

  const resourceAlias = new Set([
    'TECHNICAL_OPTIMIZATION',
    'COMPUTE_OPTIMIZATION',
    'COMPUTE_RIGHTSIZING',
    'CAPACITY_OPTIMIZATION',
    'CAPACITY_REVIEW',
  ]);
  if (resourceAlias.has(normalizedType)) {
    return uniqueCandidate(candidates, (candidate) => candidate.resourceId !== undefined);
  }

  const serviceAlias = new Set(['COST_OPTIMIZATION', 'SERVICE_OPTIMIZATION', 'COST_REVIEW']);
  if (serviceAlias.has(normalizedType)) {
    return uniqueCandidate(candidates, (candidate) => candidate.id.startsWith('service-'));
  }

  const usageAlias = new Set(['CONSUMPTION_OPTIMIZATION', 'USAGE_REVIEW']);
  if (usageAlias.has(normalizedType)) {
    return uniqueCandidate(candidates, (candidate) => candidate.id.startsWith('usage-'));
  }

  return undefined;
}

function uniqueCandidate(
  candidates: readonly RecommendationOpportunityCandidate[],
  predicate: (candidate: RecommendationOpportunityCandidate) => boolean,
): RecommendationOpportunityCandidate | undefined {
  const matches = candidates.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function removeTechnicalEvidenceFields(evidence: Record<string, unknown>): Record<string, unknown> {
  const {
    externalResourceId: _externalResourceId,
    cloudResourceId: _cloudResourceId,
    technicalEvidenceRefs: _technicalEvidenceRefs,
    technicalSampleCount: _technicalSampleCount,
    technicalCoverageDays: _technicalCoverageDays,
    latestTechnicalSampleAt: _latestTechnicalSampleAt,
    blockers: _blockers,
    ruleMatches: _ruleMatches,
    deterministicRules: _deterministicRules,
    ...rest
  } = evidence;
  return rest;
}

function removeGeneratedSafetyAndCostFields(evidence: Record<string, unknown>): Record<string, unknown> {
  const blockedKeys = new Set([
    'financialReviewOnly',
    'reviewScope',
    'technicalReviewOnly',
    'operationalAuthorization',
    'requiresManualValidation',
    'potentialMonthlySavings',
    'maxEstimatedMonthlySavings',
    'savingsCalculation',
    'savingsStatus',
  ]);
  return Object.fromEntries(Object.entries(evidence).filter(([key]) => (
    !blockedKeys.has(key) && !isGeneratedMonthlyCostField(key)
  )));
}

function isGeneratedMonthlyCostField(key: string): boolean {
  const normalized = key.replaceAll('_', '').toLowerCase();
  return normalized.includes('monthlycost')
    || normalized.includes('costmonthly')
    || normalized.includes('normalizedcost');
}

function normalizeMonthlyAmount(amount: number, coveredDays: number | undefined): number {
  return coveredDays !== undefined && Number.isFinite(coveredDays) && coveredDays > 0
    ? amount * 30 / coveredDays
    : amount;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function displayResourceName(
  candidate: RecommendationOpportunityCandidate,
  technicalResource: RecommendationEvidenceSnapshot['resources'][number] | undefined,
): string | undefined {
  const name = technicalResource?.resourceName ?? candidate.resourceName;
  if (name !== undefined && name.trim() !== '') return name.trim();
  const resourceId = technicalResource?.externalResourceId ?? candidate.resourceId;
  if (resourceId === undefined || resourceId.trim() === '') return undefined;
  const compactId = resourceId.length > 18
    ? `${resourceId.slice(0, 8)}…${resourceId.slice(-6)}`
    : resourceId;
  return `${candidate.serviceName} (${compactId})`;
}

/**
 * Detecta lenguaje o tipos que podrían interpretarse como un cambio de
 * capacidad. Si existe evidencia técnica, esos borradores se presentan como
 * revisión manual para que la salida del modelo no pueda convertir una
 * oportunidad en una instrucción ejecutable por accidente.
 */
function isCapacityAction(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized.includes('RIGHTSIZ')
    || normalized.includes('CAPACITY')
    || normalized.includes('RESIZE')
    || normalized.includes('DOWNSIZ')
    || normalized.includes('REDIMENSION');
}
