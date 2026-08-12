import { AiAuditRejectedError, FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { RecommendationExecutionPlan } from '../../../domain/models/RecommendationExecutionPlan.js';
import { AiTraceRecorder } from './aiTraceRecorder.js';
import type { FinOpsArtifactGenerator } from './finOpsArtifactGenerator.js';
import type { FinOpsContextAssembler } from './finOpsContextAssembler.js';
import type { GenerateExecutionPlanInput } from './finOpsAiTypes.js';

const approvedAuditVerdict = 'APPROVED';

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
    const startedAt = Date.now();
    const { content, auditReport, firstRawResponse } = await this.artifactGenerator.generateAuditedPlan(
      input.tenantId,
      input.userId,
      snapshot,
      recommendation,
      systemPrompt,
    );

    await this.traceRecorder.record({
      tenantId: input.tenantId,
      userId: input.userId,
      operation: 'EXECUTION_PLAN',
      model: this.mainModel,
      ...(builtContext !== undefined ? { builtContext } : {}),
      startedAt,
      responseText: firstRawResponse,
    });

    if (auditReport.verdict !== approvedAuditVerdict) {
      throw new AiAuditRejectedError('AI audit rejected execution plan output', {
        diagnosticId: `audit-${input.tenantId}-${Date.now().toString(36)}`,
        audit: auditReport,
      });
    }

    return this.recommendationRepository.createExecutionPlan({
      recommendationId: recommendation.id,
      generatedByUserId: input.userId,
      model: this.mainModel,
      auditorModel: this.auditorModel,
      content,
      auditReport,
      auditVerdict: auditReport.verdict,
      auditScore: auditReport.score,
    });
  }
}
