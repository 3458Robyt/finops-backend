import type { Request, Response } from 'express';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import { BudgetService } from '../../application/services/BudgetService.js';

export class BudgetController {
  constructor(private readonly service: BudgetService) {}
  public list = async (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ budgets: await this.service.list(this.actor(req), { ...(string(req.query['period']) !== undefined ? { period: string(req.query['period'])! } : {}), ...(string(req.query['cloudAccountId']) !== undefined ? { cloudAccountId: string(req.query['cloudAccountId'])! } : {}), ...(string(req.query['serviceName']) !== undefined ? { serviceName: string(req.query['serviceName'])! } : {}) }) }));
  public create = async (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ budget: await this.service.create(this.actor(req), req.body) }), 201);
  public update = async (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ budget: await this.service.update(this.actor(req), requiredParam(req.params['id']), req.body) }));
  public archive = async (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ budget: await this.service.archive(this.actor(req), requiredParam(req.params['id'])) }));
  public performance = async (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ performance: await this.service.getPerformance(this.actor(req), requiredParam(req.params['id'])) }));
  public alerts = async (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ alerts: await this.service.listAlerts(this.actor(req), requiredParam(req.params['id'])) }));
  public evaluate = async (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ result: await this.service.evaluate(this.actor(req), string(req.body?.budgetId)) }));
  private actor(req: Request) { if (req.auth === undefined) throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED'); return req.auth; }
  private async run(req: Request, res: Response, operation: () => Promise<unknown>, status = 200): Promise<void> { try { res.status(status).json({ success: true, ...(await operation() as object) }); } catch (error) { const known = error instanceof FinOpsBaseError; const code = known ? error.code : 'INTERNAL_ERROR'; const http = code === 'AUTHENTICATION_REQUIRED' ? 401 : code === 'AUTHORIZATION_FAILED' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 500; res.status(http).json({ success: false, code, error: known ? error.message : 'Budget operation failed' }); } }
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined; }
function requiredParam(value: unknown): string { const parsed = string(value); if (parsed === undefined) throw new FinOpsBaseError('Budget id is required', 'VALIDATION_ERROR'); return parsed; }
