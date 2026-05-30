import { Router } from 'express';
import type { RequestHandler } from 'express';
import { RecommendationController } from '../controllers/RecommendationController.js';

/**
 * Construye el router de recomendaciones de optimización.
 *
 * Se monta bajo el prefijo `/api/v1/recommendations` (ver `server.ts`). Todos
 * los endpoints exigen autenticación mediante el middleware `requireAuth`.
 *
 * El orden de registro es relevante: las rutas más específicas (p. ej.
 * `/:id/timeline`) se declaran antes que las genéricas (`/:id` y `/`) para
 * evitar colisiones de coincidencia de parámetros.
 *
 * Endpoints expuestos:
 * | Método | Subruta                        | Auth        | Handler                                       |
 * |--------|--------------------------------|-------------|-----------------------------------------------|
 * | GET    | /:id/execution-plans/latest    | requireAuth | recommendationController.getLatestExecutionPlan|
 * | POST   | /:id/execution-plan            | requireAuth | recommendationController.createExecutionPlan  |
 * | POST   | /:id/decisions                 | requireAuth | recommendationController.createDecision       |
 * | POST   | /:id/manual-execution          | requireAuth | recommendationController.createManualExecution|
 * | GET    | /:id/timeline                  | requireAuth | recommendationController.getTimeline          |
 * | GET    | /:id                           | requireAuth | recommendationController.getRecommendationById|
 * | GET    | /                              | requireAuth | recommendationController.getRecommendations   |
 *
 * @param recommendationController Controlador con los handlers de recomendaciones.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de recomendaciones.
 */
export function createRecommendationRoutes(
  recommendationController: RecommendationController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/:id/execution-plans/latest', requireAuth, recommendationController.getLatestExecutionPlan);
  router.post('/:id/execution-plan', requireAuth, recommendationController.createExecutionPlan);
  router.post('/:id/decisions', requireAuth, recommendationController.createDecision);
  router.post('/:id/manual-execution', requireAuth, recommendationController.createManualExecution);
  router.get('/:id/timeline', requireAuth, recommendationController.getTimeline);
  router.get('/:id', requireAuth, recommendationController.getRecommendationById);
  router.get('/', requireAuth, recommendationController.getRecommendations);

  return router;
}
