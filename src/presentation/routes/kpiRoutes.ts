import { Router } from 'express';
import type { RequestHandler } from 'express';
import { KpiController } from '../controllers/KpiController.js';

export function createKpiRoutes(
  kpiController: KpiController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/savings', requireAuth, kpiController.getSavings);
  router.get('/adoption', requireAuth, kpiController.getAdoption);

  return router;
}
