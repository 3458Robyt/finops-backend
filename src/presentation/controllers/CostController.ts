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

  /**
   * Construye el resumen agregado de las métricas: coste total, divisa
   * principal y desglose por servicio (coste, uso y unidad de uso acumulados).
   * La divisa principal toma la de la última métrica procesada.
   */
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
