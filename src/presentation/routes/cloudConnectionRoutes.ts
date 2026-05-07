import { Router } from 'express';
import type { RequestHandler } from 'express';
import { CloudConnectionController } from '../controllers/CloudConnectionController.js';

export function createCloudConnectionRoutes(
  cloudConnectionController: CloudConnectionController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/providers', requireAuth, cloudConnectionController.listProviders);
  router.get('/', requireAuth, cloudConnectionController.listConnections);
  router.post('/', requireAuth, cloudConnectionController.createConnection);
  router.post('/:id/provision', requireAuth, cloudConnectionController.provisionConnection);
  router.post('/:id/validate', requireAuth, cloudConnectionController.validateConnection);
  router.post('/:id/ingestion-jobs', requireAuth, cloudConnectionController.queueIngestion);
  router.get('/:id/ingestion-health', requireAuth, cloudConnectionController.getHealth);

  return router;
}
