import type { Request, Response } from 'express';
import { z } from 'zod';
import { MfaService } from '../../application/services/MfaService.js';
import { AuthenticationError, AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const privilegedRoles = new Set(['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN']);

export class MfaController {
  public constructor(private readonly service: MfaService) {}

  public status = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    try {
      res.status(200).json({
        success: true,
        enabled: await this.service.isEnabled(req.auth.userId),
        requiredForRole: privilegedRoles.has(req.auth.role),
      });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  public setup = async (req: Request, res: Response): Promise<void> => {
    if (!this.requirePrivileged(req, res) || req.auth === undefined) return;
    try {
      const result = await this.service.beginSetup(req.auth.userId, req.auth.email);
      res.status(200).json({ success: true, ...result, message: 'Escanea el código y confirma un código MFA para activarlo.' });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  public confirm = async (req: Request, res: Response): Promise<void> => {
    if (!this.requirePrivileged(req, res) || req.auth === undefined) return;
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'El código MFA debe contener seis dígitos.', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      await this.service.confirmSetup(req.auth.userId, parsed.data.code);
      res.status(200).json({ success: true, message: 'MFA quedó activado para esta cuenta.' });
    } catch (error: unknown) {
      this.respond(res, error);
    }
  };

  private requirePrivileged(req: Request, res: Response): boolean {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return false;
    }
    if (!privilegedRoles.has(req.auth.role)) {
      const error = new AuthorizationError();
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return false;
    }
    return true;
  }

  private respond(res: Response, error: unknown): void {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error instanceof FinOpsBaseError) {
      res.status(error.code === 'AUTHORIZATION_FAILED' ? 403 : error.code === 'VALIDATION_ERROR' ? 400 : 500).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }
    res.status(500).json({ success: false, error: 'No se pudo procesar MFA.', code: 'INTERNAL_SERVER_ERROR' });
  }
}
