import type { Request, Response } from 'express';
import type { ICostRepository } from '../../domain/interfaces/ICostRepository.js';
import type { InternalCostMetric } from '../../domain/models/InternalCostMetric.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

interface ServiceBreakdownItem {
  cost: number;
  currency: string;
  usage?: number;
  usageUnit?: string;
}

/**
 * Controlador de la capa de presentación para las consultas de costes diarios
 * (montado en `/api/v1/costs`). Traduce las peticiones HTTP hacia el repositorio
 * de costes y serializa las métricas junto con un resumen agregado.
 *
 * Dependencias que utiliza:
 * - {@link ICostRepository}: lectura de métricas de coste por rango de fechas.
 *
 * El endpoint requiere autenticación y acota la consulta al tenant del usuario.
 */
export class CostController {
  constructor(private readonly costRepository: ICostRepository) {}

  /**
   * Devuelve las métricas de coste diario del tenant en un rango de fechas, con
   * filtros opcionales por proveedor y cuenta de nube, junto con un resumen
   * agregado por servicio.
   *
   * Sirve: GET /api/v1/costs
   * Autenticación: requerida. Usa `req.auth.tenantId` para acotar la consulta.
   *
   * Parámetros de consulta (`req.query`):
   * - `provider` (opcional): filtra por nombre de proveedor.
   * - `cloudAccountId` (opcional): filtra por cuenta de nube.
   * - `startDate` / `endDate` (opcionales): rango de fechas ISO. Si faltan, se
   *   usa por defecto los últimos 30 días (ver {@link resolveDateRange}).
   *
   * Respuestas:
   * - 200: `{ success: true, summary, metrics, meta }` con el resumen, las
   *   métricas y metadatos de la consulta (tenant, filtros, rango y conteo).
   * - 400 VALIDATION_ERROR: alguna fecha de la query no es válida (propagado por
   *   {@link parseDateQuery} como {@link FinOpsBaseError}, respondido con 500
   *   junto al resto de errores de dominio).
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error de dominio o error inesperado al procesar los costes.
   */
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
    } catch (error: unknown) { this.respondWithError(res, error, 'No fue posible consultar los costos.'); }
  };

  public getDataOptions = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({ success: false, error: 'Autenticación requerida.', code: 'AUTHENTICATION_REQUIRED' });
        return;
      }
      const period = this.parsePeriod(req.query['period']);
      const options = await this.costRepository.getDataOptions(req.auth.tenantId, period);
      res.status(200).json({ success: true, options });
    } catch (error: unknown) { this.respondWithError(res, error, 'No fue posible cargar las opciones de costos.'); }
  };

  public getCostHistory = async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.auth === undefined) {
        res.status(401).json({ success: false, error: 'Autenticación requerida.', code: 'AUTHENTICATION_REQUIRED' });
        return;
      }
      const rangeMode = this.parseRangeMode(req.query['rangeMode']);
      const lookbackDays = this.parseLookbackDays(req.query['lookbackDays']);
      const requestedRange = this.resolveDateRange(req);
      const { startDate, endDate, usedLatestAvailableFallback } = rangeMode === 'LATEST_AVAILABLE'
        ? await this.resolveLatestAvailableRange(req.auth.tenantId, requestedRange, lookbackDays)
        : { ...requestedRange, usedLatestAvailableFallback: false };
      if (endDate <= startDate) throw new FinOpsBaseError('El rango de costos no es válido.', 'VALIDATION_ERROR');
      const requestedCurrency = typeof req.query['reportingCurrency'] === 'string' ? req.query['reportingCurrency'] : undefined;
      const reportingCurrency = this.normalizeCurrency(requestedCurrency ?? await this.costRepository.getReportingCurrency(req.auth.tenantId));
      const granularity = req.query['granularity'] === 'month' ? 'month' : 'day';
      const history = await this.costRepository.getCostHistory({
        tenantId: req.auth.tenantId,
        startDate,
        endDate,
        reportingCurrency,
        granularity,
      });
      const dataAsOf = history.coverage.lastPeriod?.toISOString() ?? null;
      const staleDays = dataAsOf === null
        ? null
        : Math.max(0, Math.floor((Date.now() - new Date(dataAsOf).getTime()) / (24 * 60 * 60 * 1000)));
      res.status(200).json({
        success: true,
        ...history,
        meta: {
          tenantId: req.auth.tenantId,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          granularity,
          rangeMode,
          lookbackDays,
          dataAsOf,
          staleDays,
          usedLatestAvailableFallback,
        },
      });
    } catch (error: unknown) { this.respondWithError(res, error, 'No fue posible consultar el histórico de costos.'); }
  };

  private parsePeriod(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new FinOpsBaseError('El período debe tener formato YYYY-MM.', 'VALIDATION_ERROR');
    return value;
  }

  private respondWithError(res: Response, error: unknown, fallback: string): void {
    respondWithFinOpsError(res, error, fallback, 'cost_operation_failed');
  }

  /**
   * Resuelve el rango de fechas de la consulta a partir de `req.query.startDate`
   * y `req.query.endDate`. Si ambas están presentes las usa; en caso contrario,
   * aplica un rango por defecto de los últimos 30 días (UTC) para los extremos ausentes.
   */
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

  /**
   * Convierte un valor de query string en fecha. Devuelve `undefined` si no se
   * proporciona, o lanza VALIDATION_ERROR si la cadena no representa una fecha válida.
   */
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

  private normalizeCurrency(value: string): string {
    const currency = value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new FinOpsBaseError('La moneda debe usar un código ISO 4217 de tres letras.', 'VALIDATION_ERROR');
    return currency;
  }

  private parseRangeMode(value: unknown): 'CALENDAR' | 'LATEST_AVAILABLE' {
    if (value === undefined || value === 'CALENDAR') return 'CALENDAR';
    if (value === 'LATEST_AVAILABLE') return value;
    throw new FinOpsBaseError('El modo de rango de costos no es válido.', 'VALIDATION_ERROR');
  }

  private parseLookbackDays(value: unknown): number {
    if (value === undefined || value === '') return 90;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
      throw new FinOpsBaseError('lookbackDays debe ser un entero entre 1 y 3650.', 'VALIDATION_ERROR');
    }
    return parsed;
  }

  private async resolveLatestAvailableRange(
    tenantId: string,
    requestedRange: { readonly startDate: Date; readonly endDate: Date },
    lookbackDays: number,
  ): Promise<{ readonly startDate: Date; readonly endDate: Date; readonly usedLatestAvailableFallback: boolean }> {
    const latestPeriod = await this.costRepository.getLatestCostPeriod(tenantId);
    if (latestPeriod === null) return { ...requestedRange, usedLatestAvailableFallback: false };
    const latestDay = new Date(Date.UTC(latestPeriod.getUTCFullYear(), latestPeriod.getUTCMonth(), latestPeriod.getUTCDate()));
    const endDate = new Date(latestDay.getTime() + 24 * 60 * 60 * 1000);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - lookbackDays);
    return {
      startDate,
      endDate,
      usedLatestAvailableFallback: endDate.getTime() !== requestedRange.endDate.getTime(),
    };
  }

  /**
   * Construye el resumen sin sumar nominalmente monedas distintas.
   */
  private buildSummary(metrics: readonly InternalCostMetric[]): {
    totalCost: number;
    currency: string | null;
    totalsByCurrency: Record<string, number>;
    serviceBreakdown: Record<string, ServiceBreakdownItem>;
  } {
    const totalsByCurrency: Record<string, number> = {};
    const serviceBreakdown: Record<string, ServiceBreakdownItem> = {};

    for (const metric of metrics) {
      totalsByCurrency[metric.currency] = (totalsByCurrency[metric.currency] ?? 0) + metric.amount;

      const breakdownKey = `${metric.service}::${metric.currency}`;
      const existingBreakdown = serviceBreakdown[breakdownKey];
      const breakdown = existingBreakdown ?? {
        cost: 0,
        currency: metric.currency,
      };

      if (metric.usageUnit !== undefined) {
        breakdown.usageUnit = metric.usageUnit;
      }

      if (existingBreakdown === undefined) {
        serviceBreakdown[breakdownKey] = breakdown;
      }

      breakdown.cost += metric.amount;

      if (metric.usage !== undefined) {
        breakdown.usage = (breakdown.usage ?? 0) + metric.usage;
      }
    }

    const currencyKeys = Object.keys(totalsByCurrency);
    return {
      // A nominal total across currencies is not meaningful. Consumers that
      // need a comparable total must use /costs/history with a reporting
      // currency and its explicit conversion metadata.
      totalCost: currencyKeys.length === 1 ? totalsByCurrency[currencyKeys[0]!] ?? 0 : 0,
      currency: currencyKeys.length === 1 ? currencyKeys[0] ?? null : null,
      totalsByCurrency,
      serviceBreakdown,
    };
  }
}
