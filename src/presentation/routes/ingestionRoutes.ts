import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { CloudConnectionController } from '../controllers/CloudConnectionController.js';
import type { ResourceLinkageController } from '../controllers/ResourceLinkageController.js';

/**
 * Construye el router de ingesta y calidad de datos a nivel tenant.
 *
 * Se monta bajo el prefijo `/api/v1/ingestion` (ver `server.ts`). Todos los
 * endpoints exigen autenticación mediante el middleware `requireAuth` y se
 * acotan al tenant del usuario autenticado. Reutiliza el
 * {@link CloudConnectionController}, que es el dueño del dominio de ingesta.
 *
 * Endpoints expuestos:
 * | Método | Subruta        | Auth        | Handler                                        |
 * |--------|----------------|-------------|------------------------------------------------|
 * | GET    | /history       | requireAuth | cloudConnectionController.listIngestionHistory |
 * | GET    | /jobs/:jobId   | requireAuth | cloudConnectionController.getIngestionJob       |
 * | POST   | /jobs/:jobId/cancel | requireManager | cloudConnectionController.cancelIngestionJob |
 * | POST   | /jobs/:jobId/archive | requireManager | cloudConnectionController.archiveIngestionJob |
 * | GET    | /data-quality  | requireAuth | cloudConnectionController.listDataQuality      |
 * | GET    | /readiness     | requireAuth | cloudConnectionController.getIngestionReadiness|
 * | GET    | /coverage      | requireAuth | cloudConnectionController.listMetricCoverage  |
 * | GET    | /resource-linkage | requireAuth | resourceLinkageController.getReadiness         |
 * | POST   | /focus-sources | requireAuth | cloudConnectionController.configureFocusSource |
 *
 * @param cloudConnectionController Controlador con los handlers de ingesta/calidad.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de ingesta y calidad de datos.
 */
export function createIngestionRoutes(
  cloudConnectionController: CloudConnectionController,
  requireAuth: RequestHandler,
  requireManager: RequestHandler,
  resourceLinkageController?: ResourceLinkageController,
): Router {
  const router = Router();

  router.post('/jobs', requireAuth, requireManager, cloudConnectionController.queueTenantIngestion);
  router.post('/backfill', requireAuth, requireManager, cloudConnectionController.queueTechnicalBackfill);
  router.post('/focus-sources', requireAuth, requireManager, cloudConnectionController.configureFocusSource);
  router.get('/history', requireAuth, cloudConnectionController.listIngestionHistory);
  if (typeof cloudConnectionController.getIngestionJob === 'function') {
    router.get('/jobs/:jobId', requireAuth, cloudConnectionController.getIngestionJob);
  }
  if (typeof cloudConnectionController.cancelIngestionJob === 'function') {
    router.post('/jobs/:jobId/cancel', requireAuth, requireManager, cloudConnectionController.cancelIngestionJob);
  }
  if (typeof cloudConnectionController.archiveIngestionJob === 'function') {
    router.post('/jobs/:jobId/archive', requireAuth, requireManager, cloudConnectionController.archiveIngestionJob);
  }
  router.get('/data-quality', requireAuth, cloudConnectionController.listDataQuality);
  router.get('/readiness', requireAuth, cloudConnectionController.getIngestionReadiness);
  router.get('/coverage', requireAuth, cloudConnectionController.listMetricCoverage);
  if (resourceLinkageController !== undefined) {
    router.get('/resource-linkage', requireAuth, resourceLinkageController.getReadiness);
  }

  return router;
}
