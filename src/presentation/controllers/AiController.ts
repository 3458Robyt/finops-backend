import type { Request, Response } from 'express';
import { z } from 'zod';
import type { FinOpsAiService } from '../../application/services/FinOpsAiService.js';
import type { IAgentLearningService } from '../../domain/interfaces/IAgentLearningService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

const chatSchema = z.object({
  message: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })).optional(),
});

const generateRecommendationsSchema = z.object({
  persist: z.boolean().optional(),
});

export class AiController {
  constructor(
    private readonly aiService: FinOpsAiService,
    private readonly learningService?: IAgentLearningService,
  ) {}

  public chat = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    const parsed = chatSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid chat payload',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const result = await this.aiService.answerChat({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        message: parsed.data.message,
        ...(parsed.data.history !== undefined ? { history: parsed.data.history } : {}),
      });

      res.status(200).json({
        success: true,
        answer: result.answer,
        context: {
          periodStart: result.snapshot.periodStart,
          periodEnd: result.snapshot.periodEnd,
          totalCost: result.snapshot.totalCost,
          currency: result.snapshot.currency,
          metricCount: result.snapshot.metricCount,
        },
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected AI chat error occurred');
    }
  };

  public generateRecommendations = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    const parsed = generateRecommendationsSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid recommendation generation payload',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const result = await this.aiService.generateRecommendations({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        persist: parsed.data.persist === true,
      });

      res.status(200).json({
        success: true,
        persisted: result.persisted,
        recommendations: result.recommendations,
        context: {
          periodStart: result.snapshot.periodStart,
          periodEnd: result.snapshot.periodEnd,
          totalCost: result.snapshot.totalCost,
          currency: result.snapshot.currency,
          metricCount: result.snapshot.metricCount,
        },
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected AI recommendation error occurred');
    }
  };

  public getLearningSummary = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    if (this.learningService === undefined) {
      res.status(503).json({
        success: false,
        error: 'Learning service is not configured',
        code: 'LEARNING_NOT_CONFIGURED',
      });
      return;
    }

    try {
      const learning = await this.learningService.getLearningSummary(req.auth.tenantId);

      res.status(200).json({
        success: true,
        learning,
      });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected AI learning summary error occurred');
    }
  };

  private handleError(error: unknown, res: Response, fallbackMessage: string): void {
    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'VALIDATION_ERROR' ? 400 : 502;
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
