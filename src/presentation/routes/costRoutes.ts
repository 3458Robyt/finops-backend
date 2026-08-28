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
 * | GET    | /history| requireAuth | costController.getCostHistory|
 * | GET    | /options| requireAuth | costController.getDataOptions|
 *
 * Los filtros se reciben por query string. `/history` devuelve agregados
 * diarios/mensuales en una moneda de reporte explícita, conserva los períodos
 * sin datos como gaps y expone por separado los periodos que no pudieron
 * convertirse por falta de una tasa compatible.
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
  router.get('/options', requireAuth, costController.getDataOptions);
  router.get('/history', requireAuth, costController.getCostHistory);
  router.get('/', requireAuth, costController.getDailyCosts);

  return router;
}
