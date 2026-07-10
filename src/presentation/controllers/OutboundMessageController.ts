import type { Request, Response } from 'express';
import { z } from 'zod';
import type { OutboundMessageService } from '../../application/services/OutboundMessageService.js';
import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';

const testSchema = z.object({
  email: z.string().email().optional(),
  telegramLinkId: z.string().min(1).optional(),
});

export class OutboundMessageController {
  constructor(private readonly outboundMessageService: OutboundMessageService) {}

  public status = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const status = await this.outboundMessageService.getStatus(auth);
      res.status(200).json({ success: true, status });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar el estado de canales');
    }
  };

  public recentDeliveries = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const limit = Math.min(Number.parseInt(String(req.query['limit'] ?? '30'), 10) || 30, 100);
      const deliveries = await this.outboundMessageService.listRecentDeliveries(auth, limit);
      res.status(200).json({ success: true, deliveries });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar entregas recientes');
    }
  };

  public sendTest = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const parsed = testSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new FinOpsBaseError('Invalid outbound test payload', 'VALIDATION_ERROR');
      }
      const input: { email?: string; telegramLinkId?: string } = {};
      if (parsed.data.email !== undefined) input.email = parsed.data.email;
      if (parsed.data.telegramLinkId !== undefined) input.telegramLinkId = parsed.data.telegramLinkId;
      const result = await this.outboundMessageService.sendTestMessages(auth, input);
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible enviar mensaje de prueba');
    }
  };

  public sendSavingsReminders = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const result = await this.outboundMessageService.sendSavingsReminders(auth);
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible enviar recordatorios');
    }
  };

  public sendRecommendationSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const result = await this.outboundMessageService.sendRecommendationSummary(auth);
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible enviar resumen de recomendaciones');
    }
  };

  private requireAuthenticated(req: Request): NonNullable<Request['auth']> {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication required', 'AUTHENTICATION_REQUIRED');
    }
    return req.auth;
  }

  private handleError(error: unknown, res: Response, fallbackMessage: string): void {
    if (error instanceof AuthorizationError) {
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'AUTHENTICATION_REQUIRED' ? 401 : 400;
      res.status(status).json({ success: false, error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ success: false, error: fallbackMessage });
  }
}
