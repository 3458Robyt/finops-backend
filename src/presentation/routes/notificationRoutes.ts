import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { NotificationController } from '../controllers/NotificationController.js';

export function createNotificationRoutes(
  notificationController: NotificationController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/', requireAuth, notificationController.list);
  router.patch('/:id/read', requireAuth, notificationController.markRead);
  router.patch('/:id/dismiss', requireAuth, notificationController.dismiss);

  return router;
}
