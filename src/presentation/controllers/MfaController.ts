import type { Request, Response } from 'express';
import { z } from 'zod';
import { MfaService } from '../../application/services/MfaService.js';
import { isPrivilegedRole } from '../../domain/security/AuthorizationPolicy.js';
import { AuthorizationError } from '../../domain/errors/errors.js';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export class MfaController {
  public constructor(private readonly service: MfaService) {}

  public status = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Se requiere autenticación.', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    try {
      const enabled = await this.service.isEnabled(req.auth.userId);
      const recovery = enabled ? await this.service.recoveryCodeStatus(req.auth.userId) : { remaining: 0 };
      res.status(200).json({
        success: true,
        enabled,
        requiredForRole: isPrivilegedRole(req.auth.role),
        recoveryCodesRemaining: recovery.remaining,
      });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No se pudo consultar el estado de MFA.', 'auth_mfa_status', req.path);
    }
  };

  public setup = async (req: Request, res: Response): Promise<void> => {
    if (!this.requirePrivileged(req, res) || req.auth === undefined) return;
    try {
      const result = await this.service.beginSetup(req.auth.userId, req.auth.email);
      res.status(200).json({ success: true, ...result, message: 'Escanea el código y confirma un código MFA para activarlo.' });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No se pudo iniciar la configuración de MFA.', 'auth_mfa_setup', req.path);
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
      const recoveryCodes = await this.service.confirmSetup(req.auth.userId, parsed.data.code);
      res.status(200).json({
        success: true,
        recoveryCodes,
        message: 'MFA quedó activado. Guarda estos códigos; no volverán a mostrarse.',
      });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No se pudo confirmar la configuración de MFA.', 'auth_mfa_confirm', req.path);
    }
  };

  public regenerateRecoveryCodes = async (req: Request, res: Response): Promise<void> => {
    if (!this.requirePrivileged(req, res) || req.auth === undefined) return;
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Confirma un código MFA de seis dígitos.', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const recoveryCodes = await this.service.regenerateRecoveryCodes(req.auth.userId, parsed.data.code);
      res.status(200).json({
        success: true,
        recoveryCodes,
        message: 'Los códigos anteriores fueron revocados. Guarda los nuevos códigos ahora.',
      });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No se pudieron regenerar los códigos de recuperación.', 'auth_mfa_regenerate_recovery', req.path);
    }
  };

  private requirePrivileged(req: Request, res: Response): boolean {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Se requiere autenticación.', code: 'AUTHENTICATION_REQUIRED' });
      return false;
    }
    if (!isPrivilegedRole(req.auth.role)) {
      respondWithFinOpsError(res, new AuthorizationError(), 'No estás autorizado para administrar MFA.', 'auth_mfa_authorization', req.path);
      return false;
    }
    return true;
  }

}
