import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AnalyticsController } from '../controllers/AnalyticsController.js';

/**
 * Construye el router de analítica de costos.
 *
 * Se monta bajo el prefijo `/api/v1/analytics` (ver `server.ts`). Todos los
 * endpoints exigen autenticación mediante el middleware `requireAuth`.
 *
 * Endpoints expuestos:
 * | Método | Subruta                | Auth        | Handler                                  |
 * |--------|------------------------|-------------|------------------------------------------|
 * | GET    | /anomalies             | requireAuth | analyticsController.getAnomalies         |
 * | GET    | /opportunities         | requireAuth | analyticsController.getOpportunities     |
 * | GET    | /forecast              | requireAuth | analyticsController.getForecast          |
 * | GET    | /trends                | requireAuth | analyticsController.getTrends            |
 * | GET    | /usage                 | requireAuth | analyticsController.getUsage             |
 * | GET    | /unit-economics        | requireAuth | analyticsController.getUnitEconomics     |
 * | GET    | /efficiency-insights   | requireAuth | analyticsController.getEfficiencyInsights|
 * | POST   | /recompute             | requireAuth | analyticsController.recompute            |
 *
 * @param analyticsController Controlador con los handlers de analítica.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de analítica.
 */
export function createAnalyticsRoutes(
  analyticsController: AnalyticsController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/anomalies', requireAuth, analyticsController.getAnomalies);
  router.get('/opportunities', requireAuth, analyticsController.getOpportunities);
  router.get('/forecast', requireAuth, analyticsController.getForecast);
  router.get('/trends', requireAuth, analyticsController.getTrends);
  router.get('/usage', requireAuth, analyticsController.getUsage);
  router.get('/unit-economics', requireAuth, analyticsController.getUnitEconomics);
  router.get('/efficiency-insights', requireAuth, analyticsController.getEfficiencyInsights);
  router.post('/recompute', requireAuth, analyticsController.recompute);

  return router;
}
