import { Router } from 'express';
import type { RequestHandler } from 'express';
import { MasterAdminController } from '../controllers/MasterAdminController.js';

export function createMasterAdminRoutes(
  masterAdminController: MasterAdminController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/tenants', requireAuth, masterAdminController.listTenants);
  router.post('/tenants', requireAuth, masterAdminController.createTenant);
  router.patch('/tenants/:tenantId', requireAuth, masterAdminController.updateTenant);
  router.get('/users', requireAuth, masterAdminController.listUsers);
  router.post('/users', requireAuth, masterAdminController.createUser);
  router.get('/assignments', requireAuth, masterAdminController.listAssignments);
  router.put('/tenants/:tenantId/users/:userId', requireAuth, masterAdminController.assignTenant);
  router.delete('/tenants/:tenantId/users/:userId', requireAuth, masterAdminController.revokeTenant);

  return router;
}
