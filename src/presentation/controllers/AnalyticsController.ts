import type { Request, Response } from 'express';
import type { CostAnalyticsService } from '../../application/services/CostAnalyticsService.js';
import type { AnalyticsGroupBy } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

const supportedGroupBy = new Set<AnalyticsGroupBy>([
  'provider',
  'account',
  'service',
  'resource',
  'environment',
]);

export class AnalyticsController {
  constructor(private readonly analyticsService: CostAnalyticsService) {}

  public getAnomalies = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const anomalies = await this.analyticsService.getAnomalies(this.parseQuery(req));
      res.status(200).json({ success: true, anomalies, meta: { count: anomalies.length } });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics anomaly error occurred');
    }
  };

  public getForecast = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const forecasts = await this.analyticsService.getForecast(this.parseQuery(req));
      res.status(200).json({ success: true, forecasts, meta: { count: forecasts.length } });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics forecast error occurred');
    }
  };

  public getTrends = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const trends = await this.analyticsService.getTrends(this.parseQuery(req));
      res.status(200).json({ success: true, trends, meta: { count: trends.length } });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics trends error occurred');
    }
  };

  public getUsage = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const usage = await this.analyticsService.getUsage(this.parseQuery(req));
      res.status(200).json({ success: true, usage, meta: { count: usage.length } });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics usage error occurred');
    }
  };

  public getUnitEconomics = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const unitEconomics = await this.analyticsService.getUnitEconomics(this.parseQuery(req));
      res.status(200).json({ success: true, unitEconomics, meta: { count: unitEconomics.length } });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics unit economics error occurred');
    }
  };

  public getEfficiencyInsights = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const insights = await this.analyticsService.getEfficiencyInsights(this.parseQuery(req));
      res.status(200).json({ success: true, insights, meta: { count: insights.length } });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics efficiency insights error occurred');
    }
  };

  public recompute = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const result = await this.analyticsService.recompute(this.parseQuery(req));
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics recompute error occurred');
    }
  };

  private parseQuery(req: Request): {
    readonly tenantId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly provider?: string;
    readonly cloudAccountId?: string;
    readonly serviceName?: string;
    readonly groupBy?: AnalyticsGroupBy;
  } {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
    }

    const from = this.parseDate(req.query['from']);
    const to = this.parseDate(req.query['to']);
    const provider = this.parseString(req.query['provider']);
    const cloudAccountId = this.parseString(req.query['cloudAccountId']);
    const serviceName = this.parseString(req.query['serviceName']);
    const groupBy = this.parseGroupBy(req.query['groupBy']);

    return {
      tenantId: req.auth.tenantId,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(cloudAccountId !== undefined ? { cloudAccountId } : {}),
      ...(serviceName !== undefined ? { serviceName } : {}),
      ...(groupBy !== undefined ? { groupBy } : {}),
    };
  }

  private parseGroupBy(value: unknown): AnalyticsGroupBy | undefined {
    const groupBy = this.parseString(value)?.toLowerCase();

    if (groupBy === undefined) {
      return undefined;
    }

    if (!supportedGroupBy.has(groupBy as AnalyticsGroupBy)) {
      throw new FinOpsBaseError(`Invalid groupBy: ${groupBy}`, 'VALIDATION_ERROR');
    }

    return groupBy as AnalyticsGroupBy;
  }

  private parseDate(value: unknown): Date | undefined {
    const raw = this.parseString(value);

    if (raw === undefined) {
      return undefined;
    }

    const date = new Date(raw);

    if (Number.isNaN(date.getTime())) {
      throw new FinOpsBaseError(`Invalid date: ${raw}`, 'VALIDATION_ERROR');
    }

    return date;
  }

  private parseString(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }

    return value.trim();
  }

  private handleError(error: unknown, res: Response, fallbackMessage: string): void {
    if (error instanceof FinOpsBaseError) {
      res.status(error.code === 'VALIDATION_ERROR' ? 400 : 500).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({ success: false, error: fallbackMessage });
  }
}
