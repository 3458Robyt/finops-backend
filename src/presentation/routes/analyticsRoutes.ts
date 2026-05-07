import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AnalyticsController } from '../controllers/AnalyticsController.js';

export function createAnalyticsRoutes(
  analyticsController: AnalyticsController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/anomalies', requireAuth, analyticsController.getAnomalies);
  router.get('/forecast', requireAuth, analyticsController.getForecast);
  router.get('/trends', requireAuth, analyticsController.getTrends);
  router.get('/usage', requireAuth, analyticsController.getUsage);
  router.get('/unit-economics', requireAuth, analyticsController.getUnitEconomics);
  router.get('/efficiency-insights', requireAuth, analyticsController.getEfficiencyInsights);
  router.post('/recompute', requireAuth, analyticsController.recompute);

  return router;
}
