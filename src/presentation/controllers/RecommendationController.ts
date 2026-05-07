import type { Request, Response } from 'express';
import type { FinOpsAiService } from '../../application/services/FinOpsAiService.js';
import type { IAgentLearningService } from '../../domain/interfaces/IAgentLearningService.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type { RecommendationFeedbackReason } from '../../domain/models/AgentLearning.js';
import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';

const supportedManualExecutionStatuses = new Set([
  'PLANNED',
  'EXECUTED',
  'PARTIAL',
  'CANCELLED',
]);

const supportedStatuses = new Set<FinOpsRecommendation['status']>([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'MANUAL_COMPLETED',
]);

export class RecommendationController {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly aiService?: FinOpsAiService,
    private readonly learningService?: IAgentLearningService,
  ) {}

  public createExecutionPlan = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      if (this.aiService === undefined) {
        res.status(503).json({
          success: false,
          error: 'AI service is not configured',
          code: 'AI_NOT_CONFIGURED',
        });
        return;
      }

      const recommendationId = this.parseString(req.params['id']);

      if (recommendationId === undefined) {
        res.status(400).json({
          success: false,
          error: 'Recommendation id is required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const executionPlan = await this.aiService.generateExecutionPlan({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        recommendationId,
      });

      res.status(200).json({
        success: true,
        executionPlan,
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected error occurred generating execution plan');
    }
  };

  public getLatestExecutionPlan = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      const recommendationId = this.parseString(req.params['id']);

      if (recommendationId === undefined) {
        res.status(400).json({
          success: false,
          error: 'Recommendation id is required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const executionPlan = await this.recommendationRepository.findLatestExecutionPlanByRecommendation(
        req.auth.tenantId,
        recommendationId,
      );

      res.status(200).json({
        success: true,
        executionPlan,
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected error occurred loading execution plan');
    }
  };

  public createManualExecution = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      if (req.auth.role !== 'ADMIN') {
        const error = new AuthorizationError();
        res.status(403).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      const recommendationId = this.parseString(req.params['id']);
      const executionPlanId = this.parseString(this.readBodyValue(req.body, 'executionPlanId'));
      const status = this.parseManualExecutionStatus(this.readBodyValue(req.body, 'status'));
      const executedAt = this.parseDate(this.readBodyValue(req.body, 'executedAt'));
      const observedMonthlySavings = this.parseNumber(this.readBodyValue(req.body, 'observedMonthlySavings'));
      const currency = this.parseString(this.readBodyValue(req.body, 'currency')) ?? 'USD';
      const notes = this.parseString(this.readBodyValue(req.body, 'notes'));
      const evidence = this.readBodyValue(req.body, 'evidence');

      if (recommendationId === undefined || status === undefined) {
        res.status(400).json({
          success: false,
          error: 'Recommendation id and status are required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      if (observedMonthlySavings !== undefined && observedMonthlySavings < 0) {
        res.status(400).json({
          success: false,
          error: 'Observed monthly savings cannot be negative',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const execution = await this.recommendationRepository.createManualExecution({
        tenantId: req.auth.tenantId,
        recommendationId,
        ...(executionPlanId !== undefined ? { executionPlanId } : {}),
        userId: req.auth.userId,
        status,
        ...(executedAt !== undefined ? { executedAt } : {}),
        ...(observedMonthlySavings !== undefined ? { observedMonthlySavings } : {}),
        currency,
        ...(notes !== undefined ? { notes } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
      });

      const recommendation = await this.recommendationRepository.findById(req.auth.tenantId, recommendationId);

      res.status(200).json({
        success: true,
        execution,
        recommendation,
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected error occurred registering manual execution');
    }
  };

  public getTimeline = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      const recommendationId = this.parseString(req.params['id']);

      if (recommendationId === undefined) {
        res.status(400).json({
          success: false,
          error: 'Recommendation id is required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const timeline = await this.recommendationRepository.findTimelineByRecommendation(
        req.auth.tenantId,
        recommendationId,
      );

      res.status(200).json({
        success: true,
        timeline,
        meta: {
          count: timeline.length,
        },
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected error occurred loading recommendation timeline');
    }
  };

  public createDecision = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      if (req.auth.role !== 'ADMIN') {
        const error = new AuthorizationError();
        res.status(403).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      const recommendationId = this.parseString(req.params['id']);
      const executionPlanId = this.parseString(this.readBodyValue(req.body, 'executionPlanId'));
      const decision = this.parseDecision(this.readBodyValue(req.body, 'decision'));
      const reasonCode = this.parseReasonCode(this.readBodyValue(req.body, 'reasonCode'));
      const reason = this.parseString(this.readBodyValue(req.body, 'reason'));

      if (
        recommendationId === undefined ||
        executionPlanId === undefined ||
        decision === undefined ||
        reasonCode === undefined
      ) {
        res.status(400).json({
          success: false,
          error: 'Recommendation id, executionPlanId, decision and reasonCode are required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      if (decision === 'REJECTED' && reason === undefined) {
        res.status(400).json({
          success: false,
          error: 'A rejection reason is required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const executionPlan = await this.recommendationRepository.findExecutionPlanById(
        req.auth.tenantId,
        executionPlanId,
      );

      if (
        executionPlan === null ||
        executionPlan.recommendationId !== recommendationId
      ) {
        res.status(404).json({
          success: false,
          error: 'Execution plan not found',
          code: 'NOT_FOUND',
        });
        return;
      }

      if (executionPlan.auditVerdict !== 'APPROVED') {
        res.status(409).json({
          success: false,
          error: 'Execution plan was not approved by AI audit',
          code: 'AI_AUDIT_REJECTED',
        });
        return;
      }

      const decisionResult = await this.recommendationRepository.createDecision({
        tenantId: req.auth.tenantId,
        recommendationId,
        executionPlanId,
        userId: req.auth.userId,
        decision,
        reasonCode,
        ...(reason !== undefined ? { reason } : {}),
      });

      const learning = await this.processLearningSafely({
        tenantId: req.auth.tenantId,
        recommendationId,
        decisionId: decisionResult.decisionId,
        userId: req.auth.userId,
        decision,
        reasonCode,
        ...(reason !== undefined ? { reason } : {}),
      });

      res.status(200).json({
        success: true,
        recommendation: decisionResult.recommendation,
        executionPlan,
        learning,
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected error occurred processing recommendation decision');
    }
  };

  public getRecommendationById = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      const recommendationId = this.parseString(req.params['id']);

      if (recommendationId === undefined) {
        res.status(400).json({
          success: false,
          error: 'Recommendation id is required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const recommendation = await this.recommendationRepository.findById(
        req.auth.tenantId,
        recommendationId,
      );

      if (recommendation === null) {
        res.status(404).json({
          success: false,
          error: 'Recommendation not found',
          code: 'NOT_FOUND',
        });
        return;
      }

      res.status(200).json({
        success: true,
        recommendation,
      });
    } catch {
      res.status(500).json({
        success: false,
        error: 'An unexpected error occurred processing recommendation detail',
      });
    }
  };

  private parseDecision(value: unknown): 'APPROVED' | 'REJECTED' | undefined {
    const decision = this.parseString(value)?.toUpperCase();

    if (decision === 'APPROVED' || decision === 'REJECTED') {
      return decision;
    }

    return undefined;
  }

  private parseManualExecutionStatus(value: unknown): 'PLANNED' | 'EXECUTED' | 'PARTIAL' | 'CANCELLED' | undefined {
    const status = this.parseString(value)?.toUpperCase();

    if (status !== undefined && supportedManualExecutionStatuses.has(status)) {
      return status as 'PLANNED' | 'EXECUTED' | 'PARTIAL' | 'CANCELLED';
    }

    return undefined;
  }

  private parseDate(value: unknown): Date | undefined {
    const raw = this.parseString(value);

    if (raw === undefined) {
      return undefined;
    }

    const date = new Date(raw);

    if (Number.isNaN(date.getTime())) {
      return undefined;
    }

    return date;
  }

  private parseNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private parseReasonCode(value: unknown): RecommendationFeedbackReason | undefined {
    const reasonCode = this.parseString(value)?.toUpperCase();
    const supportedReasons = new Set<RecommendationFeedbackReason>([
      'APPROVED_HIGH_CONFIDENCE',
      'APPROVED_LOW_RISK_QUICK_WIN',
      'REJECTED_INSUFFICIENT_EVIDENCE',
      'REJECTED_SAVINGS_UNREALISTIC',
      'REJECTED_OPERATIONAL_RISK',
      'REJECTED_BUSINESS_EXCEPTION',
      'REJECTED_ALREADY_HANDLED',
      'REJECTED_WRONG_SCOPE',
      'REJECTED_NOT_ACTIONABLE',
    ]);

    if (reasonCode !== undefined && supportedReasons.has(reasonCode as RecommendationFeedbackReason)) {
      return reasonCode as RecommendationFeedbackReason;
    }

    return undefined;
  }

  private async processLearningSafely(
    input: Parameters<IAgentLearningService['processRecommendationDecision']>[0],
  ): Promise<Awaited<ReturnType<IAgentLearningService['processRecommendationDecision']>>> {
    if (this.learningService === undefined) {
      return {
        status: 'PENDING',
        error: 'Learning service is not configured',
      };
    }

    try {
      const queued = await this.learningService.queueRecommendationDecision(input);

      if (queued.eventId !== undefined) {
        void this.learningService.processQueuedRecommendationDecision(queued.eventId)
          .catch((error: unknown) => {
            console.error('Background learning processing failed', error);
          });
      }

      return queued;
    } catch (error: unknown) {
      return {
        status: 'ERROR',
        error: error instanceof Error ? error.message : 'Learning processing failed',
      };
    }
  }

  private readBodyValue(body: unknown, key: string): unknown {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return undefined;
    }

    return (body as Record<string, unknown>)[key];
  }

  public getRecommendations = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      const status = this.parseStatus(req.query['status']);
      const cloudAccountId = this.parseString(req.query['cloudAccountId']);
      const recommendations = await this.recommendationRepository.findByTenant({
        tenantId: req.auth.tenantId,
        ...(status !== undefined ? { status } : {}),
        ...(cloudAccountId !== undefined ? { cloudAccountId } : {}),
      });

      res.status(200).json({
        success: true,
        recommendations,
        meta: {
          tenantId: req.auth.tenantId,
          count: recommendations.length,
          ...(status !== undefined ? { status } : {}),
          ...(cloudAccountId !== undefined ? { cloudAccountId } : {}),
        },
      });
    } catch (error: unknown) {
      if (error instanceof FinOpsBaseError) {
        res.status(400).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'An unexpected error occurred processing recommendations',
      });
    }
  };

  private parseStatus(value: unknown): FinOpsRecommendation['status'] | undefined {
    const status = this.parseString(value)?.toUpperCase();

    if (status === undefined) {
      return undefined;
    }

    if (!supportedStatuses.has(status as FinOpsRecommendation['status'])) {
      throw new FinOpsBaseError(`Invalid recommendation status: ${status}`, 'VALIDATION_ERROR');
    }

    return status as FinOpsRecommendation['status'];
  }

  private parseString(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }

    return value.trim();
  }

  private handleError(error: unknown, res: Response, fallbackMessage: string): void {
    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'AUTHORIZATION_FAILED'
          ? 403
          : error.code === 'AI_AUDIT_REJECTED'
            ? 409
            : 400;

      res.status(status).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: fallbackMessage,
    });
  }
}
