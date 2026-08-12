import type { Request, Response } from "express";
import type { FinOpsAiService } from "../../application/services/FinOpsAiService.js";
import type { IAgentLearningService } from "../../domain/interfaces/IAgentLearningService.js";
import type { IRecommendationRepository } from "../../domain/interfaces/IRecommendationRepository.js";
import {
  requireAuth,
  requireRecommendationExecutionRole,
  requireRecommendationId,
} from "./recommendation/recommendationRequestGuards.js";
import { respondWithRecommendationError } from "./recommendation/recommendationErrorResponse.js";
import {
  handleCreateDecision,
  handleCreateManualExecution,
} from "./recommendation/recommendationDecisionHandlers.js";

/** HTTP handlers for execution plans, manual execution and decisions. */
export class RecommendationExecutionController {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly aiService?: FinOpsAiService,
    private readonly learningService?: IAgentLearningService,
  ) {}

  public createExecutionPlan = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;
      if (!requireRecommendationExecutionRole(res, auth)) return;

      if (this.aiService === undefined) {
        res.status(503).json({
          success: false,
          error: "AI service is not configured",
          code: "AI_NOT_CONFIGURED",
        });
        return;
      }

      const recommendationId = requireRecommendationId(res, req.params["id"]);
      if (recommendationId === undefined) return;

      const executionPlan = await this.aiService.generateExecutionPlan({
        tenantId: auth.tenantId,
        userId: auth.userId,
        recommendationId,
      });

      res.status(200).json({ success: true, executionPlan });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "An unexpected error occurred generating execution plan",
      );
    }
  };

  public getLatestExecutionPlan = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const recommendationId = requireRecommendationId(res, req.params["id"]);
      if (recommendationId === undefined) return;

      const executionPlan =
        await this.recommendationRepository.findLatestExecutionPlanByRecommendation(
          auth.tenantId,
          recommendationId,
        );

      res.status(200).json({ success: true, executionPlan });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "An unexpected error occurred loading execution plan",
      );
    }
  };

  public createManualExecution = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    await handleCreateManualExecution(this.recommendationRepository, req, res);
  };

  public getTimeline = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = requireAuth(req, res);
      if (auth === undefined) return;

      const recommendationId = requireRecommendationId(res, req.params["id"]);
      if (recommendationId === undefined) return;

      const timeline =
        await this.recommendationRepository.findTimelineByRecommendation(
          auth.tenantId,
          recommendationId,
        );

      res.status(200).json({
        success: true,
        timeline,
        meta: { count: timeline.length },
      });
    } catch (error: unknown) {
      respondWithRecommendationError(
        res,
        error,
        "An unexpected error occurred loading recommendation timeline",
      );
    }
  };

  public createDecision = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    await handleCreateDecision(
      this.recommendationRepository,
      this.learningService,
      req,
      res,
    );
  };
}
