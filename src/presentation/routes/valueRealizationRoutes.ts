import { Router, type RequestHandler } from 'express';
import type { ValueRealizationController } from '../controllers/ValueRealizationController.js';

export function createValueRealizationRoutes(
  controller: ValueRealizationController,
  requireAuth: RequestHandler,
  requireReconcile: RequestHandler,
): Router {
  const router = Router();
  router.use(requireAuth);
  router.get('/summary', controller.summary);
  router.get('/items', controller.items);
  router.get('/trend', controller.trend);
  router.get('/destinations', controller.destinations);
  router.get('/export.csv', controller.exportCsv);
  router.post('/reconcile', requireReconcile, controller.reconcile);
  return router;
}
