import type { Request, Response } from 'express';
import type {
  TechnicalMetricBucket,
  TechnicalMetricOverviewInput,
  TechnicalMetricSeriesInput,
  TechnicalMetricsService,
} from '../../application/services/TechnicalMetricsService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

/**
 * Controlador de la capa de presentación para las métricas técnicas de recursos
 * cloud (montado en `/api/v1/technical-metrics`). Traduce las peticiones HTTP
 * hacia {@link TechnicalMetricsService} y serializa la respuesta.
 *
 * Expone el inventario de recursos (`cloud_resources`) y sus muestras de
 * métricas técnicas (`resource_metric_samples`), de forma separada del consumo
 * facturado de FOCUS. Todas las operaciones se acotan al tenant autenticado.
 */
export class TechnicalMetricsController {
  constructor(private readonly technicalMetricsService: TechnicalMetricsService) {}

  /**
   * Lista los recursos cloud inventariados del tenant autenticado.
   *
   * Sirve: GET /api/v1/technical-metrics/resources
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de consulta (`req.query`):
   * - `limit` (opcional): máximo de resultados; el servicio lo acota a [1, 200].
   *
   * Respuestas:
   * - 200: `{ success: true, resources }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado (ver {@link respondWithError}).
   */
  public listResources = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const resources = await this.technicalMetricsService.listResources(
        tenantId,
        this.parseLimit(req.query['limit']),
      );

      res.status(200).json({ success: true, resources });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  /**
   * Lista las muestras de métricas técnicas del tenant autenticado.
   *
   * Sirve: GET /api/v1/technical-metrics/samples
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Parámetros de consulta (`req.query`):
   * - `limit` (opcional): máximo de resultados; el servicio lo acota a [1, 200].
   *
   * Respuestas:
   * - 200: `{ success: true, samples }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado (ver {@link respondWithError}).
   */
  public listSamples = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const samples = await this.technicalMetricsService.listMetricSamples(
        tenantId,
        this.parseLimit(req.query['limit']),
      );

      res.status(200).json({ success: true, samples });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getOverview = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const overview = await this.technicalMetricsService.getOverview(
        tenantId,
        this.parseMetricQuery(req),
      );

      res.status(200).json({ success: true, overview });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getSeries = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const query = this.parseMetricQuery(req, true);
      if (query.startDate === undefined || query.endDate === undefined) {
        throw new FinOpsBaseError('startDate and endDate are required for metric series', 'VALIDATION_ERROR');
      }
      if (query.endDate <= query.startDate) {
        throw new FinOpsBaseError('endDate must be greater than startDate', 'VALIDATION_ERROR');
      }
      if (query.metricNames === undefined || query.metricNames.length === 0) {
        throw new FinOpsBaseError('At least one metricName is required for metric series', 'VALIDATION_ERROR');
      }

      const result = await this.technicalMetricsService.getSeries(tenantId, query);

      res.status(200).json({ success: true, series: result.series, meta: result.meta });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  public getCoverage = async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = this.requireTenant(req);
      const coverage = await this.technicalMetricsService.getCoverage(
        tenantId,
        this.parseMetricQuery(req),
      );

      res.status(200).json({ success: true, coverage });
    } catch (error: unknown) {
      this.respondWithError(res, error);
    }
  };

  /**
   * Garantiza que la petición está autenticada y devuelve el `tenantId`. Lanza
   * AUTHENTICATION_REQUIRED (mapeado a 401) si `req.auth` no está presente.
   */
  private requireTenant(req: Request): string {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication is required', 'AUTHENTICATION_REQUIRED');
    }

    return req.auth.tenantId;
  }

  /**
   * Convierte el query param `limit` a número, o `undefined` si no viene o no es
   * numérico. El acotado al rango válido lo realiza el servicio.
   */
  private parseLimit(value: unknown): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;

    if (typeof raw !== 'string' || raw.trim() === '') {
      return undefined;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private parseMetricQuery(req: Request, includeBucket: true): TechnicalMetricSeriesInput;
  private parseMetricQuery(req: Request, includeBucket?: false): TechnicalMetricOverviewInput;
  private parseMetricQuery(
    req: Request,
    includeBucket = false,
  ): TechnicalMetricOverviewInput | TechnicalMetricSeriesInput {
    const startDate = this.parseDate(req.query['startDate']);
    const endDate = this.parseDate(req.query['endDate']);
    const externalResourceId = this.parseString(req.query['externalResourceId']);
    const metricNames = this.parseStringList(req.query['metricNames']);
    const bucket = includeBucket ? this.parseBucket(req.query['bucket']) : undefined;
    const cursor = includeBucket ? this.parseString(req.query['cursor']) : undefined;
    const pageSize = includeBucket ? this.parseLimit(req.query['pageSize']) : undefined;

    return {
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      ...(externalResourceId !== undefined ? { externalResourceId } : {}),
      ...(metricNames !== undefined ? { metricNames } : {}),
      ...(bucket !== undefined ? { bucket } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
    };
  }

  private parseDate(value: unknown): Date | undefined {
    const raw = this.parseString(value);
    if (raw === undefined) {
      return undefined;
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new FinOpsBaseError('Invalid date query parameter', 'VALIDATION_ERROR');
    }

    return parsed;
  }

  private parseString(value: unknown): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') {
      return undefined;
    }

    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseStringList(value: unknown): readonly string[] | undefined {
    const raw = this.parseString(value);
    if (raw === undefined) {
      return undefined;
    }

    const values = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
    return values.length > 0 ? values : undefined;
  }

  private parseBucket(value: unknown): TechnicalMetricBucket | undefined {
    const raw = this.parseString(value);
    if (raw === undefined) {
      return undefined;
    }

    if (raw !== 'auto' && raw !== 'raw' && raw !== '30m' && raw !== 'hour' && raw !== 'day') {
      throw new FinOpsBaseError('Invalid metric bucket', 'VALIDATION_ERROR');
    }

    return raw;
  }

  /**
   * Manejador centralizado de errores que traduce excepciones de dominio a
   * códigos de estado HTTP: `AUTHENTICATION_REQUIRED` -> 401; cualquier otro
   * código -> 500. Error no controlado -> 500 con mensaje genérico.
   */
  private respondWithError(res: Response, error: unknown): void {
    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'AUTHENTICATION_REQUIRED'
        ? 401
        : error.code === 'VALIDATION_ERROR'
          ? 400
          : 500;

      res.status(status).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred processing technical metrics',
    });
  }
}
