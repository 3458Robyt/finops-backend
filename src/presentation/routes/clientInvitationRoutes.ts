import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { ClientInvitationController } from '../controllers/ClientInvitationController.js';

export function createClientInvitationRoutes(
  controller: ClientInvitationController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();
  router.get('/master-admin/tenants/:tenantId/client-invitations', requireAuth, controller.list);
  router.post('/master-admin/tenants/:tenantId/client-invitations', requireAuth, controller.create);
  return router;
}
