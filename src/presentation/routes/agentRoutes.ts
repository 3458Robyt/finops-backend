import { Router } from 'express';
import type { RequestHandler } from 'express';
import { AgentController } from '../controllers/AgentController.js';

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
