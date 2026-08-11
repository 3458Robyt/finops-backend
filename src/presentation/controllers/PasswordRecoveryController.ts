import type { Request, Response } from 'express';
import { z } from 'zod';
import { hashToken, PasswordRecoveryService } from '../../application/services/PasswordRecoveryService.js';
import { AuthenticationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';

const requestSchema = z.object({ email: z.string().email() });
const confirmSchema = z.object({ token: z.string().min(32), password: z.string().min(1) });

export class PasswordRecoveryController {
  public constructor(private readonly service: PasswordRecoveryService) {}

  public request = async (req: Request, res: Response): Promise<void> => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'El correo no es válido.', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      await runWithDatabaseContext({
        loginEmail: parsed.data.email,
        requestId: res.locals.requestId,
      }, () => this.service.requestReset({
        email: parsed.data.email,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
      }));
      // Deliberately identical for existing and unknown users to avoid enumeration.
      res.status(202).json({
        success: true,
        message: 'Si el correo existe, recibirás instrucciones para restablecer la contraseña.',
      });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  public confirm = async (req: Request, res: Response): Promise<void> => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'El token o la contraseña no son válidos.', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      await runWithDatabaseContext({
        passwordResetTokenHash: hashToken(parsed.data.token),
        requestId: res.locals.requestId,
      }, () => this.service.confirmReset(parsed.data));
      res.status(200).json({ success: true, message: 'Contraseña actualizada. Inicia sesión nuevamente.' });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  private respond(res: Response, error: unknown): void {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error instanceof FinOpsBaseError) {
      res.status(error.code === 'VALIDATION_ERROR' ? 400 : 500).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }
    res.status(500).json({ success: false, error: 'No se pudo procesar la recuperación.', code: 'INTERNAL_SERVER_ERROR' });
  }
}
