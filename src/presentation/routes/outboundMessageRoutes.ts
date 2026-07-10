import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { OutboundMessageController } from '../controllers/OutboundMessageController.js';

export function createOutboundMessageRoutes(
  outboundMessageController: OutboundMessageController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/status', requireAuth, outboundMessageController.status);
  router.get('/deliveries', requireAuth, outboundMessageController.recentDeliveries);
  router.post('/test', requireAuth, outboundMessageController.sendTest);
  router.post('/savings-reminders/send', requireAuth, outboundMessageController.sendSavingsReminders);
  router.post('/recommendations/summary/send', requireAuth, outboundMessageController.sendRecommendationSummary);

  return router;
}
