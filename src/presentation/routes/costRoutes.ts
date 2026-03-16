import { Router } from 'express';
import { CostController } from '../controllers/CostController.js';

export function createCostRoutes(costController: CostController): Router {
  const router = Router();

  // Endpoint: /api/v1/costs?provider=oci&accountId=xyz&date=2026-03-14
  router.get('/', costController.getDailyCosts);

  return router;
}
