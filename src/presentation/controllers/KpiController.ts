import type { Request, Response } from 'express';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';

/**
 * Controlador de la capa de presentación para los KPIs (indicadores clave de
 * rendimiento) de FinOps (montado en `/api/v1/kpis`). Traduce las peticiones
 * HTTP hacia el repositorio de recomendaciones y serializa los KPIs.
 *
 * Expone los KPIs de ahorro y de adopción de recomendaciones del tenant.
 *
 * Dependencias que utiliza:
 * - {@link IRecommendationRepository}: cálculo de KPIs de ahorro y adopción.
 *
 * Todos los endpoints requieren autenticación.
 */
export class KpiController {
  constructor(private readonly recommendationRepository: IRecommendationRepository) {}

  /**
   * Devuelve los KPIs de ahorro del tenant.
   *
   * Sirve: GET /api/v1/kpis/savings
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Respuestas:
   * - 200: `{ success: true, savings }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   */
  public getSavings = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const savings = await this.recommendationRepository.getSavingsKpis(req.auth.tenantId);
    res.status(200).json({ success: true, savings });
  };

  /**
   * Devuelve los KPIs de adopción de recomendaciones del tenant.
   *
   * Sirve: GET /api/v1/kpis/adoption
   * Autenticación: requerida. Usa `req.auth.tenantId`.
   *
   * Respuestas:
   * - 200: `{ success: true, adoption }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   */
  public getAdoption = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const adoption = await this.recommendationRepository.getAdoptionKpis(req.auth.tenantId);
    res.status(200).json({ success: true, adoption });
  };
}
