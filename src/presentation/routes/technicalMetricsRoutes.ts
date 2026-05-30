import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { TechnicalMetricsController } from '../controllers/TechnicalMetricsController.js';

/**
 * Construye el router de métricas técnicas de recursos cloud.
 *
 * Se monta bajo el prefijo `/api/v1/technical-metrics` (ver `server.ts`). Todos
 * los endpoints exigen autenticación mediante `requireAuth` y se acotan al
 * tenant del usuario autenticado.
 *
 * Endpoints expuestos:
 * | Método | Subruta     | Auth        | Handler                                  |
 * |--------|-------------|-------------|------------------------------------------|
 * | GET    | /resources  | requireAuth | technicalMetricsController.listResources |
 * | GET    | /samples    | requireAuth | technicalMetricsController.listSamples   |
 *
 * @param technicalMetricsController Controlador con los handlers de métricas técnicas.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de métricas técnicas.
 */
export function createTechnicalMetricsRoutes(
  technicalMetricsController: TechnicalMetricsController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/resources', requireAuth, technicalMetricsController.listResources);
  router.get('/samples', requireAuth, technicalMetricsController.listSamples);

  return router;
}
