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
  ): Promise<AuditedDraftsResult> {
    const firstRawResponse = await this.requestRecommendations(systemPrompt);
    let drafts = this.withTenant(parseRecommendationDrafts(firstRawResponse, snapshot), tenantId);
    let auditReport = await this.auditArtifact('recommendations', snapshot, undefined, tenantId, userId, drafts);

    if (auditReport.verdict === 'NEEDS_REVISION') {
      const revisedRaw = await this.requestRecommendationRevision(
        systemPrompt,
        auditReport.repairInstructions ?? auditReport.requiredChanges,
      );
      drafts = this.withTenant(parseRecommendationDrafts(revisedRaw, snapshot), tenantId);
      auditReport = await this.auditArtifact('recommendations', snapshot, undefined, tenantId, userId, drafts);
    }

    return {
      drafts,
      auditReport: this.combineWithDeterministicQuality(
        auditReport,
        evaluateRecommendationDrafts(drafts, snapshot, undefined, externalResourceId),
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
