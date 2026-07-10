import type { Request, Response } from 'express';
import type { SavingsReminderService } from '../../application/services/SavingsReminderService.js';

/**
 * Controlador de la capa de presentación para las notificaciones (montado en
 * `/api/v1/notifications`). Traduce las peticiones HTTP hacia el servicio de
 * recordatorios de ahorro y serializa las notificaciones del usuario.
 *
 * Expone el listado de notificaciones del usuario y las acciones de marcar como
 * leída y descartar.
 *
 * Servicios que utiliza:
 * - {@link SavingsReminderService}: obtención y actualización de estado de las notificaciones.
 *
 * Todos los endpoints requieren autenticación.
 */
export class NotificationController {
  constructor(private readonly savingsReminderService: SavingsReminderService) {}

  /**
   * Lista las notificaciones del usuario autenticado, con metadatos de conteo
   * total, no leídas y de previsualización.
   *
   * Sirve: GET /api/v1/notifications
   * Autenticación: requerida. Usa `req.auth.tenantId` y `req.auth.userId`.
   *
   * Respuestas:
   * - 200: `{ success: true, notifications, meta: { count, unreadCount, previewCount } }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 500: error inesperado al cargar las notificaciones.
   */
  public list = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const result = await this.savingsReminderService.getNotificationsForUser({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
      });

      res.status(200).json({
        success: true,
        notifications: result.notifications,
        meta: {
          count: result.notifications.length,
          unreadCount: result.unreadCount,
          previewCount: result.previewCount,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'No fue posible cargar notificaciones',
      });
    }
  };

  /**
   * Marca una notificación como leída (estado `READ`).
   *
   * Sirve: PATCH /api/v1/notifications/:id/read
   * Autenticación: requerida.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la notificación.
   *
   * Delega en {@link updateStatus}; ver allí los códigos de respuesta.
   */
  public markRead = async (req: Request, res: Response): Promise<void> => {
    await this.updateStatus(req, res, 'READ');
  };

  /**
   * Descarta una notificación (estado `DISMISSED`).
   *
   * Sirve: PATCH /api/v1/notifications/:id/dismiss
   * Autenticación: requerida.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador de la notificación.
   *
   * Delega en {@link updateStatus}; ver allí los códigos de respuesta.
   */
  public dismiss = async (req: Request, res: Response): Promise<void> => {
    await this.updateStatus(req, res, 'DISMISSED');
  };

  /**
   * Lógica compartida para actualizar el estado de una notificación a `READ` o
   * `DISMISSED`, acotada al usuario y tenant autenticados.
   *
   * Lee `req.params.id` como identificador de la notificación.
   *
   * Respuestas:
   * - 200: `{ success: true, notification }` con la notificación actualizada.
   * - 400 VALIDATION_ERROR: falta el `id` de la notificación.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 404 NOT_FOUND: la notificación no existe para ese usuario/tenant.
   * - 500: error inesperado al actualizar la notificación.
   */
  private async updateStatus(req: Request, res: Response, status: 'READ' | 'DISMISSED'): Promise<void> {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const notificationId = req.params['id'];

    if (typeof notificationId !== 'string' || notificationId.trim() === '') {
      res.status(400).json({ success: false, error: 'Notification id is required', code: 'VALIDATION_ERROR' });
      return;
    }

    const parsedNotificationId = notificationId.trim();

    try {
      const notification = status === 'READ'
        ? await this.savingsReminderService.markRead(req.auth.tenantId, req.auth.userId, parsedNotificationId)
        : await this.savingsReminderService.dismiss(req.auth.tenantId, req.auth.userId, parsedNotificationId);

      if (notification === null) {
        res.status(404).json({ success: false, error: 'Notification not found', code: 'NOT_FOUND' });
        return;
      }

      res.status(200).json({ success: true, notification });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'No fue posible actualizar la notificacion',
      });
    }
  }
}
