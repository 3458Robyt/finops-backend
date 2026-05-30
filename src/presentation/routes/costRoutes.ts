import { Router } from 'express';
import type { RequestHandler } from 'express';
import { CostController } from '../controllers/CostController.js';

/**
 * Construye el router de consulta de costos diarios.
 *
 * Se monta bajo el prefijo `/api/v1/costs` (ver `server.ts`). El endpoint
 * exige autenticación mediante el middleware `requireAuth`.
 *
 * Endpoints expuestos:
 * | Método | Subruta | Auth        | Handler                     |
 * |--------|---------|-------------|-----------------------------|
 * | GET    | /       | requireAuth | costController.getDailyCosts|
 *
 * Los filtros se reciben por query string (p. ej. `provider`, `accountId`,
 * `date`), tal como se ilustra en el comentario de la ruta.
 *
 * @param costController Controlador con el handler de costos.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con la ruta de costos.
 */
export function createCostRoutes(
  costController: CostController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  // Endpoint: /api/v1/costs?provider=oci&accountId=xyz&date=2026-03-14
  router.get('/', requireAuth, costController.getDailyCosts);

  return router;
}
