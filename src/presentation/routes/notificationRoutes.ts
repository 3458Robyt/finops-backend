import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { NotificationController } from '../controllers/NotificationController.js';

/**
 * Construye el router de notificaciones.
 *
 * Se monta bajo el prefijo `/api/v1/notifications` (ver `server.ts`). Todos
 * los endpoints exigen autenticación mediante el middleware `requireAuth`.
 *
 * Endpoints expuestos:
 * | Método | Subruta        | Auth        | Handler                          |
 * |--------|----------------|-------------|----------------------------------|
 * | GET    | /              | requireAuth | notificationController.list      |
 * | PATCH  | /:id/read      | requireAuth | notificationController.markRead  |
 * | PATCH  | /:id/dismiss   | requireAuth | notificationController.dismiss   |
 *
 * @param notificationController Controlador con los handlers de notificaciones.
 * @param requireAuth Middleware que valida el Bearer token y rellena `req.auth`.
 * @returns Router de Express con las rutas de notificaciones.
 */
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
