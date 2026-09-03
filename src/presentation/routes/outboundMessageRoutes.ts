import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { OutboundMessageController } from '../controllers/OutboundMessageController.js';

export function createOutboundMessageRoutes(
  outboundMessageController: OutboundMessageController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.get('/preferences', requireAuth, outboundMessageController.preferences);
  router.patch('/preferences', requireAuth, outboundMessageController.updatePreferences);
  router.post('/email/verify', requireAuth, outboundMessageController.verifyEmail);
  router.post('/telegram/verify', requireAuth, outboundMessageController.verifyTelegram);
  router.get('/status', requireAuth, outboundMessageController.status);
  router.get('/deliveries', requireAuth, outboundMessageController.recentDeliveries);
  router.post('/test', requireAuth, outboundMessageController.sendTest);
  router.post('/savings-reminders/send', requireAuth, outboundMessageController.sendSavingsReminders);
  router.post('/recommendations/summary/send', requireAuth, outboundMessageController.sendRecommendationSummary);
  router.post('/executive-summary/send', requireAuth, outboundMessageController.sendExecutiveSummary);

  return router;
}
