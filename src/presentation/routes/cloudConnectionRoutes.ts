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
 * | POST   | /:id/provision           | requireAuth | cloudConnectionController.provisionConnection |
 * | POST   | /:id/validate            | requireAuth | cloudConnectionController.validateConnection  |
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
