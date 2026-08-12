import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
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
import {
  dropNonActionableFinancialDrafts,
  normalizeRecommendationDrafts,
} from './recommendationDraftNormalizer.js';
import { FinOpsArtifactAiRunner } from './finOpsArtifactAiRunner.js';

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
  ) {
    this.aiRunner = new FinOpsArtifactAiRunner(aiGateway, traceRecorder, mainModel, auditorModel);
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
  ): Promise<AuditedDraftsResult> {
    const firstRawResponse = await this.aiRunner.generateRecommendations(systemPrompt);
    let drafts = this.withTenant(
      dropNonActionableFinancialDrafts(normalizeRecommendationDrafts(
        parseRecommendationDrafts(firstRawResponse, snapshot),
        readinessReport,
        technicalEvidenceSnapshot,
        cloudResourceId,
      ), readinessReport),
      tenantId,
    );
    await onAuditStart?.();
    let auditReport = await this.aiRunner.auditArtifact({
      artifactType: 'recommendations',
      snapshot,
      tenantId,
      ...(userId === undefined ? {} : { userId }),
      artifact: drafts,
      ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
      ...(deterministicAnalysis === undefined ? {} : { deterministicAnalysis }),
    });

    const repairInstructions = auditReport.repairInstructions ?? auditReport.requiredChanges;
    const hasRepairInstructions = (auditReport.repairInstructions?.length ?? 0) > 0;
    if (auditReport.verdict === 'NEEDS_REVISION' || (
      auditReport.verdict === 'REJECTED' &&
      hasRepairInstructions
    )) {
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
        ), readinessReport),
        tenantId,
      );
      await onAuditStart?.();
      auditReport = await this.aiRunner.auditArtifact({
        artifactType: 'recommendations',
        snapshot,
        tenantId,
        ...(userId === undefined ? {} : { userId }),
        artifact: drafts,
        ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
        ...(deterministicAnalysis === undefined ? {} : { deterministicAnalysis }),
      });
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
    const firstRawResponse = await this.aiRunner.generateExecutionPlan(systemPrompt);
    let content = parseExecutionPlan(firstRawResponse, recommendation);
    let auditReport = await this.aiRunner.auditArtifact({
      artifactType: 'execution_plan',
      snapshot,
      recommendation,
      tenantId,
      userId,
      artifact: content,
    });

    if (auditReport.verdict === 'NEEDS_REVISION') {
      const revisedRaw = await this.aiRunner.reviseExecutionPlan(systemPrompt, auditReport.requiredChanges);
      content = parseExecutionPlan(revisedRaw, recommendation);
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
        evaluateExecutionPlan(content, snapshot, recommendation),
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
