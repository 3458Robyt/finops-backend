import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiAuditReport, AiCandidateAuditArtifact } from '../../../domain/models/RecommendationExecutionPlan.js';
import {
  evaluateExecutionPlan,
  evaluateRecommendationDrafts,
  type QualityReport,
} from './evaluation/qualityRubric.js';
import { parseExecutionPlan, parseRecommendationDrafts } from './finOpsAiResponseParser.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import type { AiTraceRecorder } from './aiTraceRecorder.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { DeterministicTrendAnalysis } from './DeterministicTrendAnalysis.js';
import type { RecommendationReadinessReport } from './RecommendationReadinessGate.js';
import { getRecommendationPeriodDays } from './RecommendationReadinessGate.js';
import {
  dropNonActionableFinancialDrafts,
  normalizeRecommendationDrafts,
} from './recommendationDraftNormalizer.js';
import { FinOpsArtifactAiRunner, type AiArtifactRequestPolicy } from './finOpsArtifactAiRunner.js';
import { isAuditApproved, MIN_APPROVED_AUDIT_SCORE } from './auditApprovalPolicy.js';
import { selectAuditedRecommendationDrafts } from './recommendationAuditSelection.js';

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
  readonly approvedDrafts: readonly (AiRecommendationDraft & { tenantId: string })[];
  readonly rejectedDrafts: readonly (AiRecommendationDraft & { tenantId: string })[];
  readonly candidateAudits: readonly AiCandidateAuditArtifact[];
  readonly auditReport?: AiAuditReport;
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
  private readonly aiRunner: FinOpsArtifactAiRunner;

  /**
   * @param aiGateway     - Pasarela hacia el proveedor IA (generación y auditoría).
   * @param traceRecorder - Registrador de trazas de observabilidad.
   * @param mainModel     - Modelo principal de generación.
   * @param auditorModel  - Modelo auditor independiente.
   */
  constructor(
    aiGateway: IAiGateway,
    traceRecorder: AiTraceRecorder,
    mainModel: string,
    auditorModel: string,
    requestPolicy?: AiArtifactRequestPolicy,
  ) {
    this.aiRunner = new FinOpsArtifactAiRunner(
      aiGateway,
      traceRecorder,
      mainModel,
      auditorModel,
      requestPolicy,
    );
  }

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
    cloudResourceId?: string,
    technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot,
    deterministicAnalysis?: DeterministicTrendAnalysis,
    readinessReport?: RecommendationReadinessReport,
    onAuditStart?: () => Promise<void> | void,
    options: { readonly allowRepair?: boolean } = {},
  ): Promise<AuditedDraftsResult> {
    const firstRawResponse = await this.aiRunner.generateRecommendations(systemPrompt);
    const parsedDrafts = parseRecommendationDrafts(firstRawResponse, snapshot);
    if (parsedDrafts.length === 0) {
      return {
        drafts: [],
        approvedDrafts: [],
        rejectedDrafts: [],
        candidateAudits: [],
        firstRawResponse,
      };
    }
    let drafts = this.withTenant(
      dropNonActionableFinancialDrafts(normalizeRecommendationDrafts(
        parsedDrafts,
        readinessReport,
        technicalEvidenceSnapshot,
        cloudResourceId,
        getRecommendationPeriodDays(snapshot),
      ), readinessReport),
      tenantId,
    );
    let auditReport: AiAuditReport;
    const initialQuality = evaluateRecommendationDrafts(
      drafts,
      snapshot,
      undefined,
      externalResourceId,
      technicalEvidenceSnapshot,
      readinessReport,
    );
    const deterministicRejected = !initialQuality.passed;
    if (deterministicRejected) {
      auditReport = buildDeterministicRejectionReport(initialQuality);
    } else {
      await onAuditStart?.();
      auditReport = await this.aiRunner.auditArtifact({
        artifactType: 'recommendations',
        snapshot,
        tenantId,
        ...(userId === undefined ? {} : { userId }),
        artifact: drafts,
        ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
        ...(deterministicAnalysis === undefined ? {} : { deterministicAnalysis }),
        ...(readinessReport === undefined ? {} : { readinessReport }),
      });
    }

    const repairInstructions = readRepairInstructions(auditReport);
    const hasRepairInstructions = repairInstructions.length > 0;
    if (options.allowRepair !== false && !deterministicRejected && (auditReport.verdict === 'NEEDS_REVISION' || (
      auditReport.verdict === 'REJECTED' &&
      hasRepairInstructions
    ))) {
      const revisedRaw = await this.aiRunner.reviseRecommendations(
        systemPrompt,
        repairInstructions,
      );
      drafts = this.withTenant(
        dropNonActionableFinancialDrafts(normalizeRecommendationDrafts(
          parseRecommendationDrafts(revisedRaw, snapshot),
          readinessReport,
          technicalEvidenceSnapshot,
          cloudResourceId,
          getRecommendationPeriodDays(snapshot),
        ), readinessReport),
        tenantId,
      );
      const revisedQuality = evaluateRecommendationDrafts(
        drafts,
        snapshot,
        undefined,
        externalResourceId,
        technicalEvidenceSnapshot,
        readinessReport,
      );
      if (!revisedQuality.passed) {
        auditReport = buildDeterministicRejectionReport(revisedQuality);
      } else {
        await onAuditStart?.();
        auditReport = await this.aiRunner.auditArtifact({
          artifactType: 'recommendations',
          snapshot,
          tenantId,
          ...(userId === undefined ? {} : { userId }),
          artifact: drafts,
          ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
          ...(deterministicAnalysis === undefined ? {} : { deterministicAnalysis }),
          ...(readinessReport === undefined ? {} : { readinessReport }),
        });
      }
    }

    const quality = evaluateRecommendationDrafts(
      drafts,
      snapshot,
      undefined,
      externalResourceId,
      technicalEvidenceSnapshot,
      readinessReport,
    );
    const combinedAudit = this.combineWithDeterministicQuality(auditReport, quality);
    const selection = selectAuditedRecommendationDrafts({
      drafts,
      auditReport,
      snapshot,
      ...(externalResourceId === undefined ? {} : { externalResourceId }),
      ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
      ...(readinessReport === undefined ? {} : { readinessReport }),
    });

    return {
      drafts,
      approvedDrafts: this.withTenant(selection.accepted, tenantId),
      rejectedDrafts: this.withTenant(selection.rejected, tenantId),
      candidateAudits: selection.candidateAudits.map((audit) => ({
        audit,
        draft: drafts[audit.index],
        deterministicEvidence: drafts[audit.index]?.evidence,
      })),
      auditReport: { ...combinedAudit, candidateAudits: selection.candidateAudits },
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
    const firstRawResponse = await this.aiRunner.generateExecutionPlan(systemPrompt);
    let content = parseExecutionPlan(firstRawResponse, recommendation);
    let deterministicQuality = evaluateExecutionPlan(content, snapshot, recommendation);
    let auditReport = await this.aiRunner.auditArtifact({
      artifactType: 'execution_plan',
      snapshot,
      recommendation,
      tenantId,
      userId,
      artifact: content,
    });

    const repairInstructions = [
      ...readRepairInstructions(auditReport),
      ...deterministicQuality.checks
        .filter((check) => !check.passed)
        .map((check) => `Control determinista ${check.name}: ${check.detail}`),
    ];
    if (
      repairInstructions.length > 0
      && (!deterministicQuality.passed || auditReport.verdict === 'NEEDS_REVISION' || auditReport.verdict === 'REJECTED')
    ) {
      const revisedRaw = await this.aiRunner.reviseExecutionPlan(systemPrompt, repairInstructions, content);
      content = parseExecutionPlan(revisedRaw, recommendation);
      deterministicQuality = evaluateExecutionPlan(content, snapshot, recommendation);
      auditReport = await this.aiRunner.auditArtifact({
        artifactType: 'execution_plan',
        snapshot,
        recommendation,
        tenantId,
        userId,
        artifact: content,
      });
    }

    return {
      content,
      auditReport: this.combineWithDeterministicQuality(
        auditReport,
        deterministicQuality,
      ),
      firstRawResponse,
    };
  }

  /** Inyecta el `tenantId` en cada borrador de recomendación. */
  private withTenant(
    drafts: readonly AiRecommendationDraft[],
    tenantId: string,
  ): readonly (AiRecommendationDraft & { tenantId: string })[] {
    return drafts.map((draft) => ({ tenantId, ...draft }));
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
    const score = Math.min(audit.score, quality.score);
    const scoreIssue = audit.verdict === 'APPROVED' && audit.score < MIN_APPROVED_AUDIT_SCORE
      ? `La puntuación del auditor (${audit.score}) está por debajo del mínimo requerido (${MIN_APPROVED_AUDIT_SCORE}).`
      : undefined;
    const blockingIssues = [
      ...audit.blockingIssues,
      ...failed,
      ...(scoreIssue === undefined ? [] : [scoreIssue]),
    ];
    const requiredChanges = [
      ...audit.requiredChanges,
      ...failed,
      ...(scoreIssue === undefined ? [] : [scoreIssue]),
    ];

    const combined = {
      ...audit,
      verdict: 'REJECTED',
      score,
      checks,
      blockingIssues,
      requiredChanges,
      deterministicReport: quality,
    } as AiAuditReport;
    return audit.verdict === 'APPROVED'
      && isAuditApproved({ ...combined, verdict: 'APPROVED' })
      && quality.passed
      ? { ...combined, verdict: 'APPROVED' }
      : combined;
  }
}

function readRepairInstructions(audit: AiAuditReport): readonly string[] {
  return (audit.repairInstructions?.length ?? 0) > 0
    ? audit.repairInstructions!
    : audit.requiredChanges;
}

function buildDeterministicRejectionReport(quality: QualityReport): AiAuditReport {
  const failedChecks = quality.checks.filter((check) => !check.passed);
  const issues = failedChecks.map((check) => check.detail);
  return {
    verdict: 'REJECTED',
    score: quality.score,
    checks: quality.checks.map((check) => ({
      name: `deterministic:${check.name}`,
      passed: check.passed,
      notes: check.detail,
    })),
    blockingIssues: issues,
    requiredChanges: issues,
  };
}
