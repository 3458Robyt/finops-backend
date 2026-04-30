import { Router } from 'express';
import type { RequestHandler } from 'express';
import { RecommendationController } from '../controllers/RecommendationController.js';

export function createRecommendationRoutes(
  recommendationController: RecommendationController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/', requireAuth, recommendationController.getRecommendations);

  return router;
}
