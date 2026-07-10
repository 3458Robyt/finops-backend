import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { TelegramController } from '../controllers/TelegramController.js';

/**
 * Construye el router de integración con Telegram.
 *
 * Se monta bajo el prefijo `/api/v1/telegram` (ver `server.ts`). El endpoint
 * de webhook NO aplica `requireAuth` (lo invoca Telegram, no un usuario
 * autenticado); el resto de endpoints sí exigen autenticación.
 *
 * Endpoints expuestos:
 * | Método | Subruta                  | Auth        | Handler                              |
 * |--------|--------------------------|-------------|--------------------------------------|
 * | POST   | /webhook                 | —           | telegramController.webhook           |
 * | GET    | /links                   | requireAuth | telegramController.listLinks         |
 * | POST   | /links                   | requireAuth | telegramController.createLink        |
 * | PATCH  | /links/:id/disable       | requireAuth | telegramController.disableLink       |
 * | POST   | /links/:id/test-message  | requireAuth | telegramController.sendTestMessage   |
 *
 * @param telegramController Controlador con los handlers de Telegram.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de Telegram.
 */
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
