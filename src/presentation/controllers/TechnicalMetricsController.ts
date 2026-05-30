import type { Request, Response } from 'express';
import type { TechnicalMetricsService } from '../../application/services/TechnicalMetricsService.js';
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

  /**
   * Manejador centralizado de errores que traduce excepciones de dominio a
   * códigos de estado HTTP: `AUTHENTICATION_REQUIRED` -> 401; cualquier otro
   * código -> 500. Error no controlado -> 500 con mensaje genérico.
   */
  private respondWithError(res: Response, error: unknown): void {
    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'AUTHENTICATION_REQUIRED' ? 401 : 500;

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
