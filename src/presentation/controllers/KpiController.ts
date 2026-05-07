import type { Request, Response } from 'express';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';

export class KpiController {
  constructor(private readonly recommendationRepository: IRecommendationRepository) {}

  public getSavings = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const savings = await this.recommendationRepository.getSavingsKpis(req.auth.tenantId);
    res.status(200).json({ success: true, savings });
  };

  public getAdoption = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const adoption = await this.recommendationRepository.getAdoptionKpis(req.auth.tenantId);
    res.status(200).json({ success: true, adoption });
  };
}
