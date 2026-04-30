import type { Request, Response } from 'express';
import type { ICostRepository } from '../../domain/interfaces/ICostRepository.js';
import type { InternalCostMetric } from '../../domain/models/InternalCostMetric.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

interface ServiceBreakdownItem {
  cost: number;
  currency: string;
  usage?: number;
  usageUnit?: string;
}

export class CostController {
  constructor(private readonly costRepository: ICostRepository) {}

  public getDailyCosts = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({
          success: false,
          error: 'Authentication is required',
          code: 'AUTHENTICATION_REQUIRED',
        });
        return;
      }

      const { provider, cloudAccountId } = req.query;
      const { startDate, endDate } = this.resolveDateRange(req);

      const metrics = await this.costRepository.findByDateRange({
        tenantId: req.auth.tenantId,
        startDate,
        endDate,
        ...(typeof provider === 'string' && provider.trim() !== '' ? { providerName: provider } : {}),
        ...(typeof cloudAccountId === 'string' && cloudAccountId.trim() !== '' ? { cloudAccountId } : {}),
      });

      res.status(200).json({
        success: true,
        summary: this.buildSummary(metrics),
        metrics,
        meta: {
          tenantId: req.auth.tenantId,
          provider: typeof provider === 'string' ? provider : undefined,
          cloudAccountId: typeof cloudAccountId === 'string' ? cloudAccountId : undefined,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          count: metrics.length,
        },
      });
    } catch (error: unknown) {
      if (error instanceof FinOpsBaseError) {
        res.status(500).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'An unexpected error occurred processing costs',
      });
    }
  };

  private resolveDateRange(req: Request): { startDate: Date; endDate: Date } {
    const startDate = this.parseDateQuery(req.query['startDate']);
    const endDate = this.parseDateQuery(req.query['endDate']);

    if (startDate !== undefined && endDate !== undefined) {
      return { startDate, endDate };
    }

    const defaultEnd = new Date();
    const defaultStart = new Date(defaultEnd);
    defaultStart.setUTCDate(defaultStart.getUTCDate() - 30);

    return {
      startDate: startDate ?? defaultStart,
      endDate: endDate ?? defaultEnd,
    };
  }

  private parseDateQuery(value: unknown): Date | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new FinOpsBaseError(`Invalid date value: ${value}`, 'VALIDATION_ERROR');
    }

    return parsed;
  }

  private buildSummary(metrics: readonly InternalCostMetric[]): {
    totalCost: number;
    currency: string;
    serviceBreakdown: Record<string, ServiceBreakdownItem>;
  } {
    let totalCost = 0;
    let primaryCurrency = 'USD';
    const serviceBreakdown: Record<string, ServiceBreakdownItem> = {};

    for (const metric of metrics) {
      totalCost += metric.amount;
      primaryCurrency = metric.currency;

      const existingBreakdown = serviceBreakdown[metric.service];
      const breakdown = existingBreakdown ?? {
        cost: 0,
        currency: metric.currency,
      };

      if (metric.usageUnit !== undefined) {
        breakdown.usageUnit = metric.usageUnit;
      }

      if (existingBreakdown === undefined) {
        serviceBreakdown[metric.service] = breakdown;
      }

      breakdown.cost += metric.amount;

      if (metric.usage !== undefined) {
        breakdown.usage = (breakdown.usage ?? 0) + metric.usage;
      }
    }

    return {
      totalCost,
      currency: primaryCurrency,
      serviceBreakdown,
    };
  }
}
