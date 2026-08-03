import type { AiGatewayRequest, IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import { buildAuditSystemPrompt, compactSnapshot } from './finOpsAiPrompts.js';
import {
  evaluateExecutionPlan,
  evaluateRecommendationDrafts,
  type QualityReport,
} from './evaluation/qualityRubric.js';
import { parseAuditReport, parseExecutionPlan, parseRecommendationDrafts } from './finOpsAiResponseParser.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import type { AiTraceRecorder } from './aiTraceRecorder.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { DeterministicTrendAnalysis } from './DeterministicTrendAnalysis.js';
import type {
  RecommendationOpportunityCandidate,
  RecommendationReadinessReport,
} from './RecommendationReadinessGate.js';
import { isRecord } from './jsonReadHelpers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Generador de artefactos IA con auditoría
 * ═══════════════════════════════════════════════════════════════
 *
 * Encapsula el flujo de generación de artefactos IA (recomendaciones y planes
 * de ejecución) garantizando que cada uno pase por un auditor IA independiente,
 * con una única ronda de revisión si el auditor pide `NEEDS_REVISION`. Aísla del
 * servicio las llamadas al proveedor IA, el parsing y la auditoría, dejando a
 * {@link FinOpsAiService} como coordinador de snapshots, contexto y persistencia.
 *
 * @module application/services/ai/finOpsArtifactGenerator
 */

/** Resultado de generar y auditar borradores de recomendación. */
export interface AuditedDraftsResult {
  readonly drafts: readonly (AiRecommendationDraft & { tenantId: string })[];
  readonly auditReport: AiAuditReport;
  /** Texto crudo de la primera respuesta del modelo (para la traza de la operación). */
  readonly firstRawResponse: string;
}

/** Resultado de generar y auditar un plan de ejecución. */
export interface AuditedPlanResult {
  readonly content: Record<string, unknown>;
  readonly auditReport: AiAuditReport;
  /** Texto crudo de la primera respuesta del modelo (para la traza de la operación). */
  readonly firstRawResponse: string;
}

export class FinOpsArtifactGenerator {
  /**
   * @param aiGateway     - Pasarela hacia el proveedor IA (generación y auditoría).
   * @param traceRecorder - Registrador de trazas de observabilidad.
   * @param mainModel     - Modelo principal de generación.
   * @param auditorModel  - Modelo auditor independiente.
   */
  constructor(
    private readonly aiGateway: IAiGateway,
    private readonly traceRecorder: AiTraceRecorder,
    private readonly mainModel: string,
    private readonly auditorModel: string,
  ) {}

  /**
   * Genera borradores de recomendación y los audita, con una única ronda de
   * revisión si el auditor pide `NEEDS_REVISION`. El llamador es responsable de
   * inyectar el `tenantId` en los borradores devueltos por el parser.
   *
   * @param tenantId     - Tenant para el que se generan (y para las trazas de auditoría).
   * @param userId       - Usuario opcional (para las trazas).
   * @param snapshot     - Snapshot factual autorizado.
   * @param systemPrompt - Prompt de sistema ya ensamblado.
   */
  public async generateAuditedDrafts(
    tenantId: string,
    userId: string | undefined,
    snapshot: CostAnalyticsSnapshot,
    systemPrompt: string,
    externalResourceId?: string,
    technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot,
    deterministicAnalysis?: DeterministicTrendAnalysis,
    readinessReport?: RecommendationReadinessReport,
    onAuditStart?: () => Promise<void> | void,
  ): Promise<AuditedDraftsResult> {
    const firstRawResponse = await this.requestRecommendations(systemPrompt);
    let drafts = this.withTenant(
      normalizeRecommendationDrafts(
        parseRecommendationDrafts(firstRawResponse, snapshot),
        readinessReport,
        technicalEvidenceSnapshot,
      ),
      tenantId,
    );
    await onAuditStart?.();
    let auditReport = await this.auditArtifact(
      'recommendations', snapshot, undefined, tenantId, userId, drafts, technicalEvidenceSnapshot, deterministicAnalysis,
    );

    const repairInstructions = auditReport.repairInstructions ?? auditReport.requiredChanges;
    const hasRepairInstructions = (auditReport.repairInstructions?.length ?? 0) > 0;
    if (auditReport.verdict === 'NEEDS_REVISION' || (
      auditReport.verdict === 'REJECTED' &&
      hasRepairInstructions
    )) {
      const revisedRaw = await this.requestRecommendationRevision(
        systemPrompt,
        repairInstructions,
      );
      drafts = this.withTenant(
        normalizeRecommendationDrafts(
          parseRecommendationDrafts(revisedRaw, snapshot),
          readinessReport,
          technicalEvidenceSnapshot,
        ),
        tenantId,
      );
      await onAuditStart?.();
      auditReport = await this.auditArtifact(
        'recommendations', snapshot, undefined, tenantId, userId, drafts, technicalEvidenceSnapshot, deterministicAnalysis,
      );
    }

    return {
      drafts,
      auditReport: this.combineWithDeterministicQuality(
        auditReport,
        evaluateRecommendationDrafts(drafts, snapshot, undefined, externalResourceId, technicalEvidenceSnapshot),
      ),
      firstRawResponse,
    };
  }

  /**
   * Genera el contenido de un plan de ejecución y lo audita, con una única ronda
   * de revisión si el auditor pide `NEEDS_REVISION`.
   *
   * @param tenantId       - Tenant (para las trazas de auditoría).
   * @param userId         - Usuario solicitante.
   * @param snapshot       - Snapshot factual autorizado.
   * @param recommendation - Recomendación objetivo del plan.
   * @param systemPrompt   - Prompt de sistema ya ensamblado.
   */
  public async generateAuditedPlan(
    tenantId: string,
    userId: string,
    snapshot: CostAnalyticsSnapshot,
    recommendation: FinOpsRecommendation,
    systemPrompt: string,
  ): Promise<AuditedPlanResult> {
    const firstRawResponse = await this.requestExecutionPlan(systemPrompt);
    let content = parseExecutionPlan(firstRawResponse, recommendation);
    let auditReport = await this.auditArtifact('execution_plan', snapshot, recommendation, tenantId, userId, content);

    if (auditReport.verdict === 'NEEDS_REVISION') {
      const revisedRaw = await this.requestExecutionPlanRevision(systemPrompt, auditReport.requiredChanges);
      content = parseExecutionPlan(revisedRaw, recommendation);
      auditReport = await this.auditArtifact('execution_plan', snapshot, recommendation, tenantId, userId, content);
    }

    return {
      content,
      auditReport: this.combineWithDeterministicQuality(
        auditReport,
        evaluateExecutionPlan(content, snapshot),
      ),
      firstRawResponse,
    };
  }

  /** Solicita al modelo principal la generación inicial de recomendaciones. */
  private requestRecommendations(systemPrompt: string): Promise<string> {
    return this.aiGateway.generateText({
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            'Genera hasta 3 recomendaciones FinOps priorizadas en español usando solo los candidatos permitidos. Si solo hay candidatos VALIDATION_ONLY, genera recomendaciones de validacion tecnica previa.',
        },
      ],
    });
  }

  /** Solicita una corrección de las recomendaciones aplicando los cambios de auditoría. */
  private requestRecommendationRevision(systemPrompt: string, requiredChanges: readonly string[]): Promise<string> {
    return this.aiGateway.generateText({
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            'Corrige las recomendaciones usando exactamente estos cambios requeridos por auditoria.',
            'No agregues cuentas, proveedores ni recursos que no esten en el contexto.',
            'Conserva evidence.candidateId, sourceFacts, assumptions y confidence en cada recomendacion.',
            JSON.stringify(requiredChanges, null, 2),
          ].join('\n'),
        },
      ],
    });
  }

  /** Solicita al modelo principal la generación inicial del plan de ejecución. */
  private requestExecutionPlan(systemPrompt: string): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: 'Genera un plan de ejecucion manual, verificable y en español para esta recomendacion.',
        },
      ],
    });
  }

  /** Solicita una corrección del plan de ejecución aplicando los cambios de auditoría. */
  private requestExecutionPlanRevision(systemPrompt: string, requiredChanges: readonly string[]): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            'Corrige el plan de ejecucion usando exactamente estos cambios requeridos por auditoria.',
            'Mantiene el alcance manual y no prometas ejecucion automatica.',
            JSON.stringify(requiredChanges, null, 2),
          ].join('\n'),
        },
      ],
    });
  }

  /** Inyecta el `tenantId` en cada borrador de recomendación. */
  private withTenant(
    drafts: readonly AiRecommendationDraft[],
    tenantId: string,
  ): readonly (AiRecommendationDraft & { tenantId: string })[] {
    return drafts.map((draft) => ({ tenantId, ...draft }));
  }

  /**
   * Audita un artefacto generado con el modelo auditor independiente (temperatura
   * 0 para máxima consistencia), registra la traza `AUDIT` cuando hay tenant y
   * devuelve el reporte parseado.
   */
  private async auditArtifact(
    artifactType: 'recommendations' | 'execution_plan',
    snapshot: CostAnalyticsSnapshot,
    recommendation: FinOpsRecommendation | undefined,
    tenantId: string | undefined,
    userId: string | undefined,
    artifact: unknown,
    technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot,
    deterministicAnalysis?: DeterministicTrendAnalysis,
  ): Promise<AiAuditReport> {
    const startedAt = Date.now();
    const request: AiGatewayRequest = {
      model: this.auditorModel,
      responseFormat: 'json',
      temperature: 0,
      maxTokens: 900,
      messages: [
        { role: 'system', content: buildAuditSystemPrompt() },
        {
          role: 'user',
          content: [
            `Audita este artefacto: ${artifactType}.`,
            'Contexto autorizado:',
            JSON.stringify(compactSnapshot(snapshot), null, 2),
            ...(technicalEvidenceSnapshot !== undefined
              ? ['Evidencia tecnica canonica:', JSON.stringify(technicalEvidenceSnapshot, null, 2)]
              : []),
            ...(deterministicAnalysis !== undefined
              ? ['Preanalisis deterministico de tendencias:', JSON.stringify(deterministicAnalysis, null, 2)]
              : []),
            ...(recommendation !== undefined
              ? ['Recomendacion original:', JSON.stringify(recommendation, null, 2)]
              : []),
            'Artefacto generado:',
            JSON.stringify(artifact, null, 2),
          ].join('\n'),
        },
      ],
    };
    const rawResponse = await this.aiGateway.generateText(request);

    if (tenantId !== undefined) {
      await this.traceRecorder.record({
        tenantId,
        ...(userId !== undefined ? { userId } : {}),
        operation: 'AUDIT',
        model: this.auditorModel,
        startedAt,
        responseText: rawResponse,
      });
    }

    return parseAuditReport(rawResponse);
  }

  private combineWithDeterministicQuality(audit: AiAuditReport, quality: QualityReport): AiAuditReport {
    const checks = [
      ...audit.checks,
      ...quality.checks.map((check) => ({
        name: `deterministic:${check.name}`,
        passed: check.passed,
        notes: check.detail,
      })),
    ];
    const failed = quality.checks.filter((check) => !check.passed).map((check) => check.detail);

    return {
      ...audit,
      verdict: audit.verdict === 'APPROVED' && quality.passed ? 'APPROVED' : 'REJECTED',
      score: Math.min(audit.score, quality.score),
      checks,
      blockingIssues: [...audit.blockingIssues, ...failed],
      requiredChanges: [...audit.requiredChanges, ...failed],
      deterministicReport: quality,
    } as AiAuditReport;
  }
}

function normalizeRecommendationDrafts(
  drafts: readonly AiRecommendationDraft[],
  readinessReport: RecommendationReadinessReport | undefined,
  technicalEvidenceSnapshot: RecommendationEvidenceSnapshot | undefined,
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
      : technicalEvidenceSnapshot.resources.find((resource) => resource.externalResourceId === candidate.resourceId);
    const primaryMetric = technicalResource?.metrics.find((metric) => /cpu|memory/i.test(metric.metricName))
      ?? technicalResource?.metrics[0];
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
        }
      : {};
    const withoutStaleTechnicalFields = technicalResource !== undefined
      ? removeTechnicalEvidenceFields(existingEvidence)
      : candidate.resourceId === undefined
        ? removeTechnicalEvidenceFields(existingEvidence)
        : existingEvidence;
    const requiresTechnicalValidation = candidate.requiresTechnicalValidation
      || technicalResource !== undefined
      || existingEvidence['requiresTechnicalValidation'] === true;
    const safeType = technicalResource !== undefined && requiresTechnicalValidation
      ? 'PERFORMANCE_CAPACITY_REVIEW'
      : candidate.opportunityType;
    const safeTitle = technicalResource !== undefined && requiresTechnicalValidation
      ? `Revisar capacidad y rendimiento de ${technicalResource.externalResourceId}`
      : candidate.resourceId === undefined
        ? `Revisar costo y consumo de ${candidate.serviceName}`
        : draft.title;
    const safeDescription = technicalResource !== undefined && requiresTechnicalValidation
      ? [
          `Revisar la capacidad y el rendimiento del recurso ${technicalResource.externalResourceId}.`,
          candidate.sourceFacts.join(' '),
          'La evidencia permite priorizar una revisión, pero no autoriza reducción, resize ni otro cambio operativo; la validación y aprobación manual son obligatorias.',
        ].join(' ')
      : candidate.resourceId === undefined
        ? [
            candidate.sourceFacts.join(' '),
            'Esta oportunidad usa únicamente costo y consumo facturado FOCUS; no autoriza cambios operativos ni afirma utilización técnica.',
          ].join(' ')
        : draft.description;

    return {
      ...draft,
      type: safeType,
      title: safeTitle,
      description: safeDescription,
      evidence: {
        ...withoutStaleTechnicalFields,
        candidateId: candidate.id,
        evidenceLevel: candidate.evidenceLevelAllowed,
        evidenceStrength: candidate.evidenceStrength ?? withoutStaleTechnicalFields['evidenceStrength'] ?? 'MEDIUM',
        sourceFacts: candidate.sourceFacts,
        requiresTechnicalValidation,
        maxEstimatedMonthlySavings: candidate.maxEstimatedMonthlySavings,
        readiness: candidate.readiness,
        ...technicalFields,
      },
    };
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
    const resource = candidates.find((candidate) => candidate.resourceId === externalResourceId);
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
