import { Router } from 'express';
import type { RequestHandler } from 'express';
import { KpiController } from '../controllers/KpiController.js';

/**
 * Construye el router de KPIs (indicadores clave de rendimiento).
 *
 * Se monta bajo el prefijo `/api/v1/kpis` (ver `server.ts`). Todos los
 * endpoints exigen autenticación mediante el middleware `requireAuth`.
 *
 * Endpoints expuestos:
 * | Método | Subruta    | Auth        | Handler                  |
 * |--------|------------|-------------|--------------------------|
 * | GET    | /savings   | requireAuth | kpiController.getSavings |
 * | GET    | /adoption  | requireAuth | kpiController.getAdoption|
 *
 * @param kpiController Controlador con los handlers de KPIs.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de KPIs.
 */
export function createKpiRoutes(
  kpiController: KpiController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/savings', requireAuth, kpiController.getSavings);
  router.get('/adoption', requireAuth, kpiController.getAdoption);

  return router;
}
