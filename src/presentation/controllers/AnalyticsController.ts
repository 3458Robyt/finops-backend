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

/**
 * Controlador de la capa de presentación para la analítica de costes (montado
 * en `/api/v1/analytics`). Traduce las peticiones HTTP hacia los casos de uso de
 * analítica y serializa la respuesta al cliente.
 *
 * Expone consultas de anomalías, oportunidades, previsión (forecast),
 * tendencias, uso, economía unitaria e insights de eficiencia, además del
 * recálculo de la analítica. Todos los endpoints comparten un mismo conjunto de
 * filtros leídos de la query string mediante {@link parseQuery}.
 *
 * Servicios que utiliza:
 * - {@link CostAnalyticsService}: ejecuta las consultas y el recálculo de analítica.
 *
 * Todos los endpoints requieren autenticación.
 */
export class AnalyticsController {
  constructor(private readonly analyticsService: CostAnalyticsService) {}

  /**
   * Devuelve las anomalías de coste detectadas para el tenant.
   *
   * Sirve: GET /api/v1/analytics/anomalies
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery} (`from`, `to`, `provider`, `cloudAccountId`,
   * `serviceName`, `groupBy` en la query string).
   *
   * Respuestas:
   * - 200: `{ success: true, anomalies, meta: { count } }`.
   * - 400 VALIDATION_ERROR: filtros inválidos (fecha o `groupBy` no soportado).
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
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

  /**
   * Devuelve las oportunidades de optimización para el tenant.
   *
   * Sirve: GET /api/v1/analytics/opportunities
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery}.
   *
   * Nota: internamente reutiliza la consulta de anomalías del servicio de analítica.
   *
   * Respuestas:
   * - 200: `{ success: true, opportunities, meta: { count } }`.
   * - 400 VALIDATION_ERROR: filtros inválidos.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
  public getOpportunities = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const opportunities = await this.analyticsService.getAnomalies(this.parseQuery(req));
      res.status(200).json({ success: true, opportunities, meta: { count: opportunities.length } });
    } catch (error: unknown) {
      this.handleError(error, res, 'An unexpected analytics opportunities error occurred');
    }
  };

  /**
   * Devuelve la previsión (forecast) de coste para el tenant.
   *
   * Sirve: GET /api/v1/analytics/forecast
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery}.
   *
   * Respuestas:
   * - 200: `{ success: true, forecasts, meta: { count } }`.
   * - 400 VALIDATION_ERROR: filtros inválidos.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
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

  /**
   * Devuelve las tendencias de coste para el tenant.
   *
   * Sirve: GET /api/v1/analytics/trends
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery}.
   *
   * Respuestas:
   * - 200: `{ success: true, trends, meta: { count } }`.
   * - 400 VALIDATION_ERROR: filtros inválidos.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
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

  /**
   * Devuelve las métricas de uso para el tenant.
   *
   * Sirve: GET /api/v1/analytics/usage
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery}.
   *
   * Respuestas:
   * - 200: `{ success: true, usage, meta: { count } }`.
   * - 400 VALIDATION_ERROR: filtros inválidos.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
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

  /**
   * Devuelve la economía unitaria (coste por unidad de negocio) para el tenant.
   *
   * Sirve: GET /api/v1/analytics/unit-economics
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery}.
   *
   * Respuestas:
   * - 200: `{ success: true, unitEconomics, meta: { count } }`.
   * - 400 VALIDATION_ERROR: filtros inválidos.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
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

  /**
   * Devuelve los insights de eficiencia para el tenant.
   *
   * Sirve: GET /api/v1/analytics/efficiency-insights
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery}.
   *
   * Respuestas:
   * - 200: `{ success: true, insights, meta: { count } }`.
   * - 400 VALIDATION_ERROR: filtros inválidos.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
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

  /**
   * Recalcula la analítica de costes agregada para el tenant.
   *
   * Sirve: POST /api/v1/analytics/recompute
   * Autenticación: requerida.
   * Filtros: ver {@link parseQuery} (leídos de la query string).
   *
   * Respuestas:
   * - 200: `{ success: true, ...result }` con el resultado del recálculo.
   * - 400 VALIDATION_ERROR: filtros inválidos.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado de analítica.
   */
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

  /**
   * Extrae y normaliza los filtros comunes de analítica desde la query string,
   * acotándolos siempre al `tenantId` del usuario autenticado.
   *
   * Lee de `req.query`: `from` y `to` (fechas), `provider`, `cloudAccountId`,
   * `serviceName` (cadenas) y `groupBy` (dimensión de agrupación). Los campos
   * ausentes o vacíos se omiten del objeto resultante.
   *
   * Lanza AUTHENTICATION_REQUIRED si `req.auth` no está presente, y
   * VALIDATION_ERROR si alguna fecha o el `groupBy` es inválido.
   */
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

  /**
   * Valida y normaliza la dimensión de agrupación `groupBy` (en minúsculas).
   * Devuelve `undefined` si no se proporciona, o lanza VALIDATION_ERROR si el
   * valor no pertenece al conjunto soportado ({@link supportedGroupBy}).
   */
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

  /**
   * Convierte un valor de entrada en una fecha. Devuelve `undefined` si no se
   * proporciona, o lanza VALIDATION_ERROR si la cadena no representa una fecha válida.
   */
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

  /**
   * Normaliza un valor de entrada a string: devuelve la cadena recortada si es
   * un texto no vacío, o `undefined` en cualquier otro caso.
   */
  private parseString(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }

    return value.trim();
  }

  /**
   * Manejador centralizado de errores de analítica que traduce excepciones de
   * dominio a códigos de estado HTTP:
   * - {@link FinOpsBaseError} con código `VALIDATION_ERROR` -> 400; cualquier
   *   otro código -> 500.
   * - Error no controlado -> 500 con `fallbackMessage`.
   */
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
