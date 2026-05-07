import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AiController } from '../controllers/AiController.js';

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
