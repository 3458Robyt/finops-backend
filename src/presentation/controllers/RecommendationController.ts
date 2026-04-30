import type { Request, Response } from 'express';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

const supportedStatuses = new Set<FinOpsRecommendation['status']>([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'MANUAL_COMPLETED',
]);

export class RecommendationController {
  constructor(private readonly recommendationRepository: IRecommendationRepository) {}

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
}
