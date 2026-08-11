import type { Request, Response } from 'express';
import type { ValueRealizationFilters } from '../../domain/interfaces/IValueRealizationRepository.js';
import type { ValueRealizationService } from '../../application/services/ValueRealizationService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import { safeErrorMessage } from '../../application/observability/safeError.js';

const allowedMeasurementStatuses = new Set(['WAITING_FOR_DATA', 'READY', 'CALCULATED', 'INSUFFICIENT_EVIDENCE', 'VERIFIED', 'REJECTED', 'FAILED', 'NO_EXECUTION']);

export class ValueRealizationController {
  constructor(private readonly service: ValueRealizationService) {}

  public summary = (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ summary: await this.service.getSummary(this.filters(req)) }));
  public items = (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ page: await this.service.listItems(this.filters(req)) }));
  public trend = (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ points: await this.service.listTrend(this.filters(req)) }));
  public destinations = (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ destinations: await this.service.listDestinationSummary({ tenantId: this.auth(req).tenantId, period: monthPeriod(requiredQuery(req.query['period'])), ...(queryString(req.query['currency']) === undefined ? {} : { currency: queryString(req.query['currency'])! }) }) }));
  public reconcile = (req: Request, res: Response): Promise<void> => this.run(req, res, async () => ({ result: await this.service.reconcile(this.auth(req).tenantId, positiveInteger(req.body?.limit, 50, 100)) }));

  public exportCsv = async (req: Request, res: Response): Promise<void> => {
    try {
      const items = await this.service.exportItems(this.filters(req, 10_000));
      const headers = ['recommendationId', 'title', 'provider', 'cloudAccount', 'serviceName', 'resourceId', 'currency', 'estimatedMonthlySavings', 'reportedMonthlySavings', 'observedSavings', 'projectedMonthlySavings', 'verifiedMonthlySavings', 'costIncreaseMonthlyAmount', 'coverageRatio', 'confidenceLevel', 'billingSource', 'costBasis', 'measurementStatus', 'nextAction', 'executedAt', 'observationEnd', 'verifiedAt', 'evidenceSummary'];
      const rows = items.map((item) => [item.recommendationId, item.title, item.provider, item.cloudAccountName, item.serviceName ?? '', item.resourceId ?? '', item.currency, item.estimatedMonthlySavings, item.reportedMonthlySavings, item.observedSavings ?? '', item.projectedMonthlySavings ?? '', item.verifiedMonthlySavings, item.costIncreaseMonthlyAmount, item.coverageRatio ?? '', item.confidenceLevel ?? '', item.billingSource ?? '', item.costBasis ?? '', item.measurementStatus ?? '', item.nextAction, item.executedAt?.toISOString() ?? '', item.observationEnd?.toISOString() ?? '', item.verifiedAt?.toISOString() ?? '', `service=${item.serviceName ?? ''};resource=${item.resourceId ?? ''};status=${item.measurementStatus ?? 'NO_EXECUTION'}`]);
      const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
      res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="valor-realizado.csv"').status(200).send(`\uFEFF${csv}`);
    } catch (error) { this.handleError(res, error, 'No fue posible exportar el valor realizado'); }
  };

  private filters(req: Request, maxPageSize?: number): ValueRealizationFilters {
    const auth = this.auth(req);
    const date = (name: string): Date | undefined => {
      const value = queryString(req.query[name]);
      if (value === undefined) return undefined;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) throw new FinOpsBaseError(`El filtro ${name} no es una fecha válida`, 'VALIDATION_ERROR');
      return parsed;
    };
    const status = queryString(req.query['status']);
    if (status !== undefined && !allowedMeasurementStatuses.has(status)) {
      throw new FinOpsBaseError('El estado de medición no es válido', 'VALIDATION_ERROR');
    }
    const pageSize = positiveInteger(req.query['pageSize'], 50, maxPageSize ?? 100);
    const executedFrom = date('executedFrom');
    const executedTo = date('executedTo');
    const verifiedFrom = date('verifiedFrom');
    const verifiedTo = date('verifiedTo');
    const cursor = queryString(req.query['cursor']);
    const base: Omit<ValueRealizationFilters, 'status'> = {
      tenantId: auth.tenantId,
      ...optional('currency', req), ...optional('provider', req), ...optional('cloudAccountId', req),
      ...optional('serviceName', req), ...optional('resourceId', req), ...optional('severity', req), ...optional('search', req),
      ...(executedFrom !== undefined ? { executedFrom } : {}),
      ...(executedTo !== undefined ? { executedTo } : {}),
      ...(verifiedFrom !== undefined ? { verifiedFrom } : {}),
      ...(verifiedTo !== undefined ? { verifiedTo } : {}),
      ...(booleanQuery(req.query['onlyIncreases']) ? { onlyIncreases: true } : {}),
      ...(booleanQuery(req.query['onlyPending']) ? { onlyPending: true } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      pageSize,
    };
    return status === undefined ? base : { ...base, status: status as NonNullable<ValueRealizationFilters['status']> };
  }

  private auth(req: Request) { if (req.auth === undefined) throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED'); return req.auth; }
  private async run(req: Request, res: Response, operation: () => Promise<unknown>): Promise<void> { try { res.status(200).json({ success: true, ...(await operation() as object) }); } catch (error) { this.handleError(res, error, 'La operación de valor realizado falló'); } }
  private handleError(res: Response, error: unknown, fallback: string): void { const known = error instanceof FinOpsBaseError; const code = known ? error.code : 'INTERNAL_ERROR'; const status = code === 'AUTHENTICATION_REQUIRED' ? 401 : code === 'AUTHORIZATION_FAILED' ? 403 : code === 'VALIDATION_ERROR' ? 400 : 500; if (!known) console.error(JSON.stringify({ level: 'error', event: 'value_realization_operation_failed', error: safeErrorMessage(error) })); res.status(status).json({ success: false, code, error: known ? error.message : fallback }); }
}

function queryString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined; }
function optional(key: string, req: Request): Record<string, string> { const value = queryString(req.query[key]); return value === undefined ? {} : { [key]: value }; }
function positiveInteger(value: unknown, fallback: number, max: number): number { const parsed = Number.parseInt(String(value ?? ''), 10); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback; }
function booleanQuery(value: unknown): boolean { return value === 'true' || value === true; }
function requiredQuery(value: unknown): string { const parsed = queryString(value); if (parsed === undefined) throw new FinOpsBaseError('El período es obligatorio', 'VALIDATION_ERROR'); return parsed; }
function monthPeriod(value: string): Date { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new FinOpsBaseError('El período debe tener formato YYYY-MM', 'VALIDATION_ERROR'); const [year, month] = value.split('-').map(Number); return new Date(Date.UTC(year!, month! - 1, 1)); }
function csvCell(value: unknown): string { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
