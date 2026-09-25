import { randomUUID } from 'node:crypto';
import { AiAuditRejectedError, FinOpsBaseError, ProviderTimeoutError } from '../../../domain/errors/errors.js';
import type { ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { RecommendationExecutionPlan } from '../../../domain/models/RecommendationExecutionPlan.js';
import { AiTraceRecorder } from './aiTraceRecorder.js';
import type { FinOpsArtifactGenerator } from './finOpsArtifactGenerator.js';
import type { FinOpsContextAssembler } from './finOpsContextAssembler.js';
import type { GenerateExecutionPlanInput } from './finOpsAiTypes.js';
import { isAuditApproved } from './auditApprovalPolicy.js';
import { isRecord } from './jsonReadHelpers.js';

const approvedAuditVerdict = 'APPROVED';
const executionPlanDeadlineMs = 120_000;

/** Generates and persists one audited, manual execution plan for one recommendation. */
export class FinOpsAiExecutionPlanRunner {
  constructor(
    private readonly analyticsRepository: ICostAnalyticsRepository,
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly contextAssembler: FinOpsContextAssembler,
    private readonly artifactGenerator: FinOpsArtifactGenerator,
    private readonly traceRecorder: AiTraceRecorder,
    private readonly mainModel: string,
    private readonly auditorModel: string,
  ) {}

  public async run(input: GenerateExecutionPlanInput): Promise<RecommendationExecutionPlan> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + executionPlanDeadlineMs;
    const recommendation = await this.recommendationRepository.findById(
      input.tenantId,
      input.recommendationId,
    );
    if (recommendation === null) {
      throw new FinOpsBaseError('Recommendation not found', 'NOT_FOUND');
    }

    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const { builtContext, systemPrompt } = await this.contextAssembler.assembleExecutionPlanContext({
      tenantId: input.tenantId,
      userId: input.userId,
      snapshot,
      recommendation,
    });
    try {
      const { content, auditReport, firstRawResponse } = await this.artifactGenerator.generateAuditedPlan(
        input.tenantId,
        input.userId,
        snapshot,
        recommendation,
        systemPrompt,
        deadlineAt,
      );

      if (auditReport.verdict !== approvedAuditVerdict || !isAuditApproved(auditReport)) {
        throw new AiAuditRejectedError('AI audit rejected execution plan output', {
          diagnosticId: randomUUID(),
          audit: auditReport,
        });
      }

      if (Date.now() >= deadlineAt) {
        throw new ProviderTimeoutError('La generación del plan excedió el límite total de 120 segundos.');
      }

      const executionPlan = await this.recommendationRepository.createExecutionPlan({
        recommendationId: recommendation.id,
        generatedByUserId: input.userId,
        model: this.mainModel,
        auditorModel: this.auditorModel,
        content,
        auditReport,
        auditVerdict: auditReport.verdict,
        auditScore: auditReport.score,
      });

      await this.recordTrace({
        tenantId: input.tenantId,
        userId: input.userId,
        operation: 'EXECUTION_PLAN',
        model: this.mainModel,
        ...(builtContext !== undefined ? { builtContext } : {}),
        startedAt,
        responseText: firstRawResponse,
      });
      return executionPlan;
    } catch (error) {
      await this.recordTrace({
        tenantId: input.tenantId,
        userId: input.userId,
        operation: 'EXECUTION_PLAN',
        model: this.mainModel,
        ...(builtContext !== undefined ? { builtContext } : {}),
        startedAt,
        error: summarizeTraceError(error),
      });
      throw error;
    }
  }

  private async recordTrace(input: Parameters<AiTraceRecorder['record']>[0]): Promise<void> {
    try {
      await this.traceRecorder.record(input);
    } catch {
      // Trace persistence must not change the audited plan's result.
    }
  }
}

function summarizeTraceError(error: unknown): unknown {
  if (!(error instanceof AiAuditRejectedError)) return error;
  const report = isRecord(error.audit) ? error.audit : {};
  const checks = Array.isArray(report['checks']) ? report['checks'] : [];
  const blockers = Array.isArray(report['blockingIssues']) ? report['blockingIssues'] : [];
  const requiredChanges = Array.isArray(report['requiredChanges']) ? report['requiredChanges'] : [];
  const verdict = ['APPROVED', 'REJECTED', 'NEEDS_REVISION'].includes(String(report['verdict']))
    ? String(report['verdict'])
    : 'UNKNOWN';
  const score = typeof report['score'] === 'number' && Number.isFinite(report['score'])
    ? Math.trunc(report['score'])
    : 'UNKNOWN';
  const failedChecks = checks.filter((check) => isRecord(check) && check['passed'] === false).length;
  return new Error(
    `AI_AUDIT_REJECTED; verdict=${verdict}; score=${score}; failedChecks=${failedChecks}; blockers=${blockers.length}; requiredChanges=${requiredChanges.length}`,
  );
}
