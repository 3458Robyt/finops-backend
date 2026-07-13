import type { Request, Response } from 'express';
import { CostAllocationService } from '../../application/services/CostAllocationService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { CostAllocationRuleStatus } from '../../domain/models/CostAllocation.js';

export class CostAllocationController {
  constructor(private readonly service: CostAllocationService) {}
  public listRules = (req: Request, res: Response) => this.run(req, res, async () => ({ rules: await this.service.listRules(this.actor(req), status(string(req.query['status']))) }));
  public createRule = (req: Request, res: Response) => this.run(req, res, async () => ({ rule: await this.service.createRule(this.actor(req), req.body) }), 201);
  public updateRule = (req: Request, res: Response) => this.run(req, res, async () => ({ rule: await this.service.updateRule(this.actor(req), required(string(req.params['id'])), req.body) }));
  public activateRule = (req: Request, res: Response) => this.run(req, res, async () => ({ rule: await this.service.activateRule(this.actor(req), required(string(req.params['id']))) }));
  public archiveRule = (req: Request, res: Response) => this.run(req, res, async () => ({ rule: await this.service.archiveRule(this.actor(req), required(string(req.params['id']))) }));
  public preview = (req: Request, res: Response) => this.run(req, res, async () => ({ preview: await this.service.preview(this.actor(req), req.body.rule, required(string(req.body?.period))) }));
  public summary = (req: Request, res: Response) => this.run(req, res, async () => ({ summary: await this.service.summary(this.actor(req), { period: required(string(req.query['period'])), ...(string(req.query['cloudAccountId']) === undefined ? {} : { cloudAccountId: string(req.query['cloudAccountId'])! }), ...(string(req.query['serviceName']) === undefined ? {} : { serviceName: string(req.query['serviceName'])! }) }) }));
  public comparison = (req: Request, res: Response) => this.run(req, res, async () => ({ comparison: await this.service.comparison(this.actor(req), { period: required(string(req.query['period'])), ...(string(req.query['cloudAccountId']) === undefined ? {} : { cloudAccountId: string(req.query['cloudAccountId'])! }), ...(string(req.query['serviceName']) === undefined ? {} : { serviceName: string(req.query['serviceName'])! }) }) }));
  public unallocated = (req: Request, res: Response) => this.run(req, res, async () => ({ items: await this.service.unallocated(this.actor(req), { period: required(string(req.query['period'])), ...(string(req.query['currency']) === undefined ? {} : { currency: string(req.query['currency'])! }), ...(string(req.query['cloudAccountId']) === undefined ? {} : { cloudAccountId: string(req.query['cloudAccountId'])! }), ...(string(req.query['serviceName']) === undefined ? {} : { serviceName: string(req.query['serviceName'])! }) }) }));
  public resourceSummary = (req: Request, res: Response) => this.run(req, res, async () => ({ summary: await this.service.resourceSummary(this.actor(req), required(string(req.params['resourceId']))) }));
  public exportCsv = async (req: Request, res: Response): Promise<void> => { try { const summary = await this.service.summary(this.actor(req), { period: required(string(req.query['period'])) }); const rows = ['currency,allocation,cost,metrics,resources', ...summary.flatMap((item) => item.dimensions.map((row) => [item.currency, csv(row.allocationKey), row.cost, row.metricCount, row.resourceCount].join(',')))]; res.type('text/csv').attachment(`showback-${req.query['period']}.csv`).send(rows.join('\n')); } catch (error) { this.error(error, res); } };
  private actor(req: Request) { if (req.auth === undefined) throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED'); return req.auth; }
  private async run(req: Request, res: Response, action: () => Promise<object>, status = 200): Promise<void> { try { res.status(status).json({ success: true, ...(await action()) }); } catch (error) { this.error(error, res); } }
  private error(error: unknown, res: Response): void { const known = error instanceof FinOpsBaseError; const code = known ? error.code : 'INTERNAL_ERROR'; const status = code === 'AUTHENTICATION_REQUIRED' ? 401 : code === 'AUTHORIZATION_FAILED' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'VALIDATION_ERROR' ? 400 : 500; res.status(status).json({ success: false, code, error: known ? error.message : 'Cost allocation operation failed' }); }
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined; }
function required(value: string | undefined): string { if (value === undefined) throw new FinOpsBaseError('Required value is missing', 'VALIDATION_ERROR'); return value; }
function status(value: string | undefined): CostAllocationRuleStatus | undefined { if (value === undefined) return undefined; if (value === 'DRAFT' || value === 'ACTIVE' || value === 'ARCHIVED') return value; throw new FinOpsBaseError('Invalid allocation rule status', 'VALIDATION_ERROR'); }
function csv(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
