import type { Request, Response } from 'express';
import { z } from 'zod';
import type { OutboundMessageService } from '../../application/services/OutboundMessageService.js';
import type { MessagingPreferenceService } from '../../application/services/MessagingPreferenceService.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { MessagingPreferenceUpdate } from '../../domain/models/MessagingPreference.js';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

const testSchema = z.object({
  email: z.string().email().optional(),
  telegramLinkId: z.string().min(1).optional(),
});

const preferenceSchema = z.object({
  emailEnabled: z.boolean().optional(),
  telegramEnabled: z.boolean().optional(),
  operationalAlerts: z.boolean().optional(),
  recommendationAlerts: z.boolean().optional(),
  financialAlerts: z.boolean().optional(),
  executiveSummaries: z.boolean().optional(),
}).strict();

export class OutboundMessageController {
  constructor(
    private readonly outboundMessageService: OutboundMessageService,
    private readonly messagingPreferenceService: MessagingPreferenceService,
  ) {}

  public preferences = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const preferences = await this.messagingPreferenceService.get(auth);
      res.status(200).json({ success: true, preferences });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cargar las preferencias de mensajería', 'outbound_operation_failed', req.path);
    }
  };

  public updatePreferences = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const parsed = preferenceSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        throw new FinOpsBaseError('Debes indicar al menos una preferencia válida', 'VALIDATION_ERROR');
      }
      const update: MessagingPreferenceUpdate = {
        ...(parsed.data.emailEnabled === undefined ? {} : { emailEnabled: parsed.data.emailEnabled }),
        ...(parsed.data.telegramEnabled === undefined ? {} : { telegramEnabled: parsed.data.telegramEnabled }),
        ...(parsed.data.operationalAlerts === undefined ? {} : { operationalAlerts: parsed.data.operationalAlerts }),
        ...(parsed.data.recommendationAlerts === undefined ? {} : { recommendationAlerts: parsed.data.recommendationAlerts }),
        ...(parsed.data.financialAlerts === undefined ? {} : { financialAlerts: parsed.data.financialAlerts }),
        ...(parsed.data.executiveSummaries === undefined ? {} : { executiveSummaries: parsed.data.executiveSummaries }),
      };
      const preferences = await this.messagingPreferenceService.update(auth, update);
      res.status(200).json({ success: true, preferences });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible guardar las preferencias de mensajería', 'outbound_operation_failed', req.path);
    }
  };

  public verifyEmail = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.outboundMessageService.requireConfigurationAdmin(auth);
      const verified = await this.outboundMessageService.verifyEmailConfiguration();
      res.status(200).json({ success: true, verified });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible verificar la conexión SMTP', 'outbound_operation_failed', req.path);
    }
  };

  public verifyTelegram = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      this.outboundMessageService.requireConfigurationAdmin(auth);
      const verified = await this.outboundMessageService.verifyTelegramConfiguration();
      res.status(200).json({ success: true, verified });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible verificar el bot de Telegram', 'outbound_operation_failed', req.path);
    }
  };

  public status = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const status = await this.outboundMessageService.getStatus(auth);
      res.status(200).json({ success: true, status });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cargar el estado de canales', 'outbound_operation_failed', req.path);
    }
  };

  public recentDeliveries = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const limit = Math.min(Number.parseInt(String(req.query['limit'] ?? '30'), 10) || 30, 100);
      const deliveries = await this.outboundMessageService.listRecentDeliveries(auth, limit);
      res.status(200).json({ success: true, deliveries });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cargar entregas recientes', 'outbound_operation_failed', req.path);
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
      respondWithFinOpsError(res, error, 'No fue posible enviar mensaje de prueba', 'outbound_operation_failed', req.path);
    }
  };

  public sendSavingsReminders = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const result = await this.outboundMessageService.sendSavingsReminders(auth);
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible enviar recordatorios', 'outbound_operation_failed', req.path);
    }
  };

  public sendRecommendationSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const result = await this.outboundMessageService.sendRecommendationSummary(auth);
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible enviar resumen de recomendaciones', 'outbound_operation_failed', req.path);
    }
  };

  public sendExecutiveSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      const auth = this.requireAuthenticated(req);
      const result = await this.outboundMessageService.sendExecutiveSummary(auth);
      res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible enviar el resumen ejecutivo', 'outbound_operation_failed', req.path);
    }
  };

  private requireAuthenticated(req: Request): NonNullable<Request['auth']> {
    if (req.auth === undefined) {
      throw new FinOpsBaseError('Authentication required', 'AUTHENTICATION_REQUIRED');
    }
    return req.auth;
  }

}
