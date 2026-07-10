import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AiController } from '../controllers/AiController.js';

/**
 * Construye el router de las funcionalidades de IA (chat y recomendaciones).
 *
 * Se monta bajo el prefijo `/api/v1/ai` (ver `server.ts`). Todos los
 * endpoints exigen autenticación mediante el middleware `requireAuth`.
 *
 * Endpoints expuestos:
 * | Método | Subruta                     | Auth        | Handler                              |
 * |--------|-----------------------------|-------------|--------------------------------------|
 * | GET    | /learning/summary           | requireAuth | aiController.getLearningSummary      |
 * | POST   | /chat                       | requireAuth | aiController.chat                    |
 * | POST   | /recommendations/generate   | requireAuth | aiController.generateRecommendations |
 *
 * @param aiController Controlador con los handlers de IA.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de IA.
 */
export function createAiRoutes(
  aiController: AiController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/learning/summary', requireAuth, aiController.getLearningSummary);
  router.post('/chat', requireAuth, aiController.chat);
  router.post('/recommendations/generate', requireAuth, aiController.generateRecommendations);

  return router;
}
