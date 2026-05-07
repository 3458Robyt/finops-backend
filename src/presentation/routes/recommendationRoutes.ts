import { Router } from 'express';
import type { RequestHandler } from 'express';
import { RecommendationController } from '../controllers/RecommendationController.js';

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
