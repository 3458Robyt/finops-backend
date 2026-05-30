import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AgentController } from '../controllers/AgentController.js';

/**
 * Construye el router de gestión del agente de IA.
 *
 * Se monta bajo el prefijo `/api/v1/agent` (ver `server.ts`). Todos los
 * endpoints exigen autenticación mediante el middleware `requireAuth`.
 *
 * Endpoints expuestos:
 * | Método | Subruta                      | Auth        | Handler                        |
 * |--------|------------------------------|-------------|--------------------------------|
 * | GET    | /profile                     | requireAuth | agentController.getProfile     |
 * | POST   | /profile/activate            | requireAuth | agentController.activateProfile|
 * | GET    | /tenant-rules                | requireAuth | agentController.listTenantRules|
 * | POST   | /tenant-rules                | requireAuth | agentController.createTenantRule|
 * | PATCH  | /tenant-rules/:id/disable    | requireAuth | agentController.disableTenantRule|
 * | GET    | /context-traces              | requireAuth | agentController.listContextTraces|
 * | GET    | /knowledge-graph             | requireAuth | agentController.getKnowledgeGraph|
 * | POST   | /context/backfill            | requireAuth | agentController.backfillContext|
 *
 * @param agentController Controlador con los handlers del agente.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas del agente.
 */
export function createAgentRoutes(
  agentController: AgentController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/profile', requireAuth, agentController.getProfile);
  router.post('/profile/activate', requireAuth, agentController.activateProfile);
  router.get('/tenant-rules', requireAuth, agentController.listTenantRules);
  router.post('/tenant-rules', requireAuth, agentController.createTenantRule);
  router.patch('/tenant-rules/:id/disable', requireAuth, agentController.disableTenantRule);
  router.get('/context-traces', requireAuth, agentController.listContextTraces);
  router.get('/knowledge-graph', requireAuth, agentController.getKnowledgeGraph);
  router.post('/context/backfill', requireAuth, agentController.backfillContext);

  return router;
}
