import { Request, Response } from 'express';
import { DataIngestionService } from '../../application/services/DataIngestionService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export class CostController {
  constructor(private readonly dataIngestionService: DataIngestionService) {}

  /**
   * Obtener costos de una cuenta en una fecha específica (o el día actual por defecto)
   */
  public getDailyCosts = async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider, accountId, date } = req.query;

      if (!provider || typeof provider !== 'string') {
        res.status(400).json({ error: 'Missing or invalid provider' });
        return;
      }

      if (!accountId || typeof accountId !== 'string') {
        res.status(400).json({ error: 'Missing or invalid accountId' });
        return;
      }

      const queryDate = date && typeof date === 'string' 
        ? new Date(date) 
        : new Date();

      if (isNaN(queryDate.getTime())) {
        res.status(400).json({ error: 'Invalid date format' });
        return;
      }

      const ingestionResult = await this.dataIngestionService.runDailyIngestion(
        provider,
        accountId,
        queryDate
      );

      const metrics = ingestionResult.metrics;

      // ── Agrupar y resumir los costos para estructurar mejor el JSON ──
      let totalCost = 0;
      let primaryCurrency = 'USD';
      const serviceBreakdown: Record<string, { cost: number; currency: string; usage?: number; usageUnit?: string }> = {};

      for (const req of metrics) {
        totalCost += req.amount;
        primaryCurrency = req.currency;

        if (!serviceBreakdown[req.service]) {
          serviceBreakdown[req.service] = {
            cost: 0,
            currency: req.currency,
            usage: 0,
            usageUnit: req.usageUnit
          };
        }

        serviceBreakdown[req.service].cost += req.amount;
        
        if (req.usage !== undefined) {
          serviceBreakdown[req.service].usage! += req.usage;
        }
      }

      res.status(200).json({
        success: true,
        summary: {
          totalCost,
          currency: primaryCurrency,
          serviceBreakdown
        },
        metrics: metrics,
        meta: {
          provider: ingestionResult.providerName,
          accountId: ingestionResult.accountId,
          date: ingestionResult.date.toISOString().split('T')[0],
          durationMs: ingestionResult.durationMs,
          count: ingestionResult.metricsCount
        }
      });
    } catch (error: unknown) {
      if (error instanceof FinOpsBaseError) {
        res.status(500).json({ 
          success: false, 
          error: error.message, 
          code: error.name 
        });
        return;
      }

      res.status(500).json({ 
        success: false, 
        error: 'An unexpected error occurred processing costs' 
      });
    }
  };
}
