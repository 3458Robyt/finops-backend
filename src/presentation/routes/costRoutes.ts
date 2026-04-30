import { Router } from 'express';
import type { RequestHandler } from 'express';
import { CostController } from '../controllers/CostController.js';

export function createCostRoutes(
  costController: CostController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  // Endpoint: /api/v1/costs?provider=oci&accountId=xyz&date=2026-03-14
  router.get('/', requireAuth, costController.getDailyCosts);

  return router;
}
