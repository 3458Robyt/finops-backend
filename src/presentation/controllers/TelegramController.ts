import type { Request, Response } from 'express';
import { z } from 'zod';
import type { TelegramBotService } from '../../application/services/TelegramBotService.js';
import type { TelegramLinkService } from '../../application/services/TelegramLinkService.js';
import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';

const createLinkSchema = z.object({
  email: z.string().email(),
  chatId: z.string().min(1),
  telegramUserId: z.string().optional(),
  telegramUsername: z.string().optional(),
});

export class TelegramController {
  constructor(
    private readonly botService: TelegramBotService,
    private readonly linkService: TelegramLinkService,
    private readonly webhookSecret: string | undefined,
    private readonly enabled: boolean,
  ) {}

  public webhook = async (req: Request, res: Response): Promise<void> => {
    if (!this.enabled) {
      res.status(503).json({ success: false, error: 'Telegram integration is disabled', code: 'TELEGRAM_DISABLED' });
      return;
    }

    if (this.webhookSecret === undefined || this.webhookSecret.trim() === '') {
      res.status(503).json({ success: false, error: 'Telegram webhook secret is not configured', code: 'CONFIGURATION_ERROR' });
      return;
    }

    if (req.header('X-Telegram-Bot-Api-Secret-Token') !== this.webhookSecret) {
      res.status(401).json({ success: false, error: 'Invalid Telegram webhook secret', code: 'AUTHENTICATION_FAILED' });
      return;
    }

    try {
      await this.botService.handleUpdate(req.body);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible procesar el webhook de Telegram');
    }
  };

  public listLinks = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const links = await this.linkService.listLinks(req.auth);
      res.status(200).json({ success: true, links });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar vinculos Telegram');
    }
  };

  public createLink = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const parsed = createLinkSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid Telegram link payload', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const link = await this.linkService.createLink(req.auth, {
        email: parsed.data.email,
        chatId: parsed.data.chatId,
        ...(parsed.data.telegramUserId !== undefined ? { telegramUserId: parsed.data.telegramUserId } : {}),
        ...(parsed.data.telegramUsername !== undefined ? { telegramUsername: parsed.data.telegramUsername } : {}),
      });
      res.status(201).json({ success: true, link });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible crear el vinculo Telegram');
    }
  };

  public disableLink = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const linkId = this.parseId(req);

    if (linkId === undefined) {
      res.status(400).json({ success: false, error: 'Telegram link id is required', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const link = await this.linkService.disableLink(req.auth, linkId);
      res.status(200).json({ success: true, link });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible desactivar el vinculo Telegram');
    }
  };

  public sendTestMessage = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const linkId = this.parseId(req);

    if (linkId === undefined) {
      res.status(400).json({ success: false, error: 'Telegram link id is required', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const link = await this.linkService.sendTestMessage(req.auth, linkId);
      res.status(200).json({ success: true, link });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible enviar mensaje de prueba');
    }
  };

  private parseId(req: Request): string | undefined {
    const id = req.params['id'];
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
  }

  private handleError(error: unknown, res: Response, fallbackMessage: string): void {
    if (error instanceof AuthorizationError) {
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return;
    }

    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'VALIDATION_ERROR'
        ? 400
        : error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'CONFLICT'
            ? 409
            : 500;

      res.status(status).json({ success: false, error: error.message, code: error.code });
      return;
    }

    res.status(500).json({ success: false, error: fallbackMessage });
  }
}
