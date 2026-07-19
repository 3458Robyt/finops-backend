import { Router } from 'express';
import type { RequestHandler } from 'express';
import { CloudConnectionController } from '../controllers/CloudConnectionController.js';

/**
 * Construye el router de conexiones a proveedores de nube.
 *
 * Se monta bajo el prefijo `/api/v1/cloud-connections` (ver `server.ts`).
 * Todos los endpoints exigen autenticación mediante el middleware `requireAuth`.
 *
 * Endpoints expuestos:
 * | Método | Subruta                  | Auth        | Handler                                       |
 * |--------|--------------------------|-------------|-----------------------------------------------|
 * | GET    | /providers               | requireAuth | cloudConnectionController.listProviders       |
 * | GET    | /                        | requireAuth | cloudConnectionController.listConnections     |
 * | POST   | /                        | requireAuth | cloudConnectionController.createConnection    |
 * | GET    | /:id/onboarding          | requireAuth | cloudConnectionController.getOnboardingDetail |
 * | POST   | /:id/credentials         | manager     | cloudConnectionController.storeCredential     |
 * | DELETE | /:id/credentials/:credId | manager     | cloudConnectionController.revokeCredential    |
 * | POST   | /:id/validate            | requireAuth | cloudConnectionController.validateConnection  |
 * | POST   | /:id/activate            | manager     | cloudConnectionController.activateConnection  |
 * | POST   | /:id/ingestion-jobs      | requireAuth | cloudConnectionController.queueIngestion      |
 * | GET    | /:id/ingestion-health    | requireAuth | cloudConnectionController.getHealth           |
 *
 * @param cloudConnectionController Controlador con los handlers de conexiones.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de conexiones a la nube.
 */
export function createCloudConnectionRoutes(
  cloudConnectionController: CloudConnectionController,
  requireAuth: RequestHandler,
  requireManager: RequestHandler,
): Router {
  const router = Router();

  router.get('/providers', requireAuth, cloudConnectionController.listProviders);
  router.get('/', requireAuth, cloudConnectionController.listConnections);
  router.post('/', requireAuth, requireManager, cloudConnectionController.createConnection);
  router.get('/:id/onboarding', requireAuth, cloudConnectionController.getOnboardingDetail);
  router.patch('/:id', requireAuth, requireManager, cloudConnectionController.updateConnection);
  router.patch('/:id/status', requireAuth, requireManager, cloudConnectionController.setConnectionStatus);
  router.post('/:id/credentials', requireAuth, requireManager, cloudConnectionController.storeCredential);
  router.delete('/:id/credentials/:credentialId', requireAuth, requireManager, cloudConnectionController.revokeCredential);
  router.post('/:id/validate', requireAuth, requireManager, cloudConnectionController.validateConnection);
  router.post('/:id/focus-preview', requireAuth, requireManager, cloudConnectionController.previewFocusSource);
  router.post('/:id/activate', requireAuth, requireManager, cloudConnectionController.activateConnection);
  router.post('/:id/ingestion-jobs', requireAuth, requireManager, cloudConnectionController.queueIngestion);
  router.post('/:id/ingestion-jobs/retry-failed', requireAuth, requireManager, cloudConnectionController.retryFailedIngestionJobs);
  router.post('/:id/ingestion-jobs/cancel-pending', requireAuth, requireManager, cloudConnectionController.cancelPendingIngestionJobs);
  router.put('/:id/billing-source', requireAuth, requireManager, cloudConnectionController.configureBillingSource);
  router.put('/:id/metric-definitions', requireAuth, requireManager, cloudConnectionController.configureMetricDefinitions);
  router.get('/:id/ingestion-health', requireAuth, cloudConnectionController.getHealth);

  return router;
}
