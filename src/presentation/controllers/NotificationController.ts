import type { Request, Response } from 'express';
import type { SavingsReminderService } from '../../application/services/SavingsReminderService.js';

export class NotificationController {
  constructor(private readonly savingsReminderService: SavingsReminderService) {}

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

  public markRead = async (req: Request, res: Response): Promise<void> => {
    await this.updateStatus(req, res, 'READ');
  };

  public dismiss = async (req: Request, res: Response): Promise<void> => {
    await this.updateStatus(req, res, 'DISMISSED');
  };

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
