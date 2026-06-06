import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { CloudConnectionController } from '../controllers/CloudConnectionController.js';

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
 * | GET    | /data-quality  | requireAuth | cloudConnectionController.listDataQuality      |
 * | GET    | /readiness     | requireAuth | cloudConnectionController.getIngestionReadiness|
 * | POST   | /focus-sources | requireAuth | cloudConnectionController.configureFocusSource |
 *
 * @param cloudConnectionController Controlador con los handlers de ingesta/calidad.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de ingesta y calidad de datos.
 */
export function createIngestionRoutes(
  cloudConnectionController: CloudConnectionController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.post('/jobs', requireAuth, cloudConnectionController.queueTenantIngestion);
  router.post('/focus-sources', requireAuth, cloudConnectionController.configureFocusSource);
  router.get('/history', requireAuth, cloudConnectionController.listIngestionHistory);
  router.get('/data-quality', requireAuth, cloudConnectionController.listDataQuality);
  router.get('/readiness', requireAuth, cloudConnectionController.getIngestionReadiness);

  return router;
}
