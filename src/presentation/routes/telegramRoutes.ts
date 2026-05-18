import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { TelegramController } from '../controllers/TelegramController.js';

export function createTelegramRoutes(
  telegramController: TelegramController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.post('/webhook', telegramController.webhook);
  router.get('/links', requireAuth, telegramController.listLinks);
  router.post('/links', requireAuth, telegramController.createLink);
  router.patch('/links/:id/disable', requireAuth, telegramController.disableLink);
  router.post('/links/:id/test-message', requireAuth, telegramController.sendTestMessage);

  return router;
}
