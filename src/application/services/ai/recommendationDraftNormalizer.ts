import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type {
  RecommendationOpportunityCandidate,
  RecommendationReadinessReport,
} from './RecommendationReadinessGate.js';
import { isRecord } from './jsonReadHelpers.js';

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
): readonly AiRecommendationDraft[] {
  if (readinessReport === undefined) {
    return drafts;
  }

  return drafts.map((draft) => {
    const candidate = findCandidate(draft, readinessReport.candidates);
    if (candidate === undefined) {
      return draft;
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
    const requiresTechnicalValidation = candidate.requiresTechnicalValidation
      || technicalResource !== undefined
      || technicalValidationOnly
      || existingEvidence['requiresTechnicalValidation'] === true;
    const resourceIdentifier = technicalResource?.externalResourceId ?? candidate.resourceId;
    const safeType = technicalReviewOnly
      ? 'PERFORMANCE_CAPACITY_REVIEW'
      : technicalValidationOnly
        ? 'TECHNICAL_VALIDATION_REQUIRED'
      : candidate.opportunityType;
    const safeTitle = technicalReviewOnly && resourceIdentifier !== undefined
      ? `Revisar capacidad y rendimiento de ${resourceIdentifier}`
      : technicalValidationOnly && resourceIdentifier !== undefined
        ? `Validar señales técnicas de ${resourceIdentifier}`
      : technicalResource !== undefined
        ? [
            draft.description,
            'La validación técnica y la aprobación manual son obligatorias; esta recomendación no autoriza por sí sola resize, apagado ni otro cambio operativo.',
          ].join(' ')
        : candidate.resourceId === undefined
          ? `Revisar costo y consumo de ${candidate.serviceName}`
        : draft.title;
    const safeDescription = technicalReviewOnly && resourceIdentifier !== undefined
      ? [
          `Revisar la capacidad y el rendimiento del recurso ${resourceIdentifier}.`,
          'La evidencia permite priorizar una revisión previa. Esta salida es informativa, no es una autorización ni un plan de ejecución. La validación y aprobación manual son obligatorias antes de cualquier cambio operativo.',
        ].join(' ')
      : technicalValidationOnly && resourceIdentifier !== undefined
        ? [
            `Validar las señales técnicas y el enlace de inventario del recurso ${resourceIdentifier}.`,
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

    return {
      ...draftWithoutSavings,
      ...(technicalValidationOnly || technicalReviewOnly || generatedSavings === undefined
        ? {}
        : { estimatedMonthlySavings: generatedSavings }),
      ...(normalizedCloudResourceId !== undefined ? { cloudResourceId: normalizedCloudResourceId } : {}),
      ...(normalizedCloudResourceId === undefined && candidate.resourceId !== undefined
        ? { resourceLinkReason: 'INVENTORY_RESOURCE_NOT_FOUND' }
        : {}),
      type: safeType,
      title: safeTitle,
      description: safeDescription,
      evidence: {
        ...withoutStaleTechnicalFields,
        candidateId: candidate.id,
        ...(resourceIdentifier !== undefined ? { externalResourceId: resourceIdentifier } : {}),
        costEvidenceRefs: candidate.costEvidenceRefs,
        evidenceLevel: candidate.evidenceLevelAllowed,
        evidenceStrength: candidate.evidenceStrength ?? withoutStaleTechnicalFields['evidenceStrength'] ?? 'MEDIUM',
        sourceFacts: technicalReviewOnly
          ? candidate.sourceFacts.filter((fact) => /^(CPU|Memoria)\b/i.test(fact))
          : candidate.sourceFacts,
        requiresTechnicalValidation,
        maxEstimatedMonthlySavings: candidate.maxEstimatedMonthlySavings,
        ...(generatedSavings !== undefined && (technicalValidationOnly || technicalReviewOnly)
          ? {
              potentialMonthlySavings: generatedSavings,
              savingsStatus: 'POTENTIAL_NOT_VERIFIED',
            }
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
    const isFinancialCandidate = candidate !== undefined && candidate.resourceId === undefined;
    const hasPositivePotential = (candidate?.maxEstimatedMonthlySavings ?? 0) > 0;
    const estimatedSavings = typeof draft.estimatedMonthlySavings === 'number' ? draft.estimatedMonthlySavings : 0;
    return !(isFinancialCandidate && hasPositivePotential && estimatedSavings <= 0);
  });
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
