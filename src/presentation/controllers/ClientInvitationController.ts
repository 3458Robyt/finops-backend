import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, type LoginResult } from '../../application/services/AuthService.js';
import type { ClientInvitationService } from '../../application/services/ClientInvitationService.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import { hashOpaqueToken } from '../../application/auth/opaqueToken.js';
import { setRefreshCookie, type AuthCookieConfig } from '../auth/authCookie.js';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120).optional(),
  role: z.enum(['CLIENT_APPROVER', 'CLIENT_VIEWER']),
});

const acceptSchema = z.object({
  code: z.string().min(20).max(200),
  name: z.string().min(2).max(120),
  password: z.string().min(12).max(128),
});

export class ClientInvitationController {
  public constructor(
    private readonly service: ClientInvitationService,
    private readonly authService: AuthService,
    private readonly cookieConfig: AuthCookieConfig,
    private readonly refreshTokenTtlSeconds: number,
    private readonly clientPortalUrl: string,
  ) {}

  public create = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    const parsed = createSchema.safeParse(req.body);
    const tenantId = this.routeParam(req, 'tenantId');
    if (!parsed.success || tenantId === undefined) {
      res.status(400).json({ success: false, error: 'Los datos de invitación no son válidos.', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const result = await this.service.create({
        actorUserId: req.auth.userId,
        tenantId,
        email: parsed.data.email,
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        role: parsed.data.role,
        clientPortalUrl: this.clientPortalUrl,
      });
      res.status(201).json({ success: true, ...result });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible crear la invitación de cliente.', 'client_invitation_create', req.path);
    }
  };

  public list = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    const tenantId = this.routeParam(req, 'tenantId');
    if (tenantId === undefined) {
      res.status(400).json({ success: false, error: 'tenantId es obligatorio.', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const invitations = await this.service.list(req.auth.userId, tenantId);
      res.status(200).json({ success: true, invitations });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cargar las invitaciones.', 'client_invitation_list', req.path);
    }
  };

  public accept = async (req: Request, res: Response): Promise<void> => {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'El código, nombre o contraseña no son válidos.', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const accepted = await runWithDatabaseContext({
        clientInvitationTokenHash: hashOpaqueToken(parsed.data.code),
        ...(res.locals?.requestId === undefined ? {} : { requestId: res.locals.requestId }),
      }, () => this.service.accept({
        tokenHash: parsed.data.code,
        name: parsed.data.name,
        password: parsed.data.password,
      }));
      const result = await runWithDatabaseContext({
        loginEmail: accepted.email,
        ...(res.locals?.requestId === undefined ? {} : { requestId: res.locals.requestId }),
      }, () => this.authService.login({
        email: accepted.email,
        password: parsed.data.password,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(req.header('user-agent') === undefined ? {} : { userAgent: req.header('user-agent')! }),
      }));

      if ('mfaRequired' in result) {
        res.status(200).json({
          success: true,
          mfaRequired: true,
          ...(result.mfaSetupRequired === undefined ? {} : { mfaSetupRequired: true }),
          challengeToken: result.challengeToken,
          expiresAt: result.expiresAt.toISOString(),
          ...(result.secret === undefined ? {} : { secret: result.secret }),
          ...(result.otpauthUri === undefined ? {} : { otpauthUri: result.otpauthUri }),
          user: result.user,
        });
        return;
      }

      setRefreshCookieIfPresent(res, result, this.cookieConfig, this.refreshTokenTtlSeconds);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible aceptar la invitación.', 'client_invitation_accept', req.path);
    }
  };

  private routeParam(req: Request, name: string): string | undefined {
    const value = req.params[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  private authenticationRequired(res: Response): void {
    res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
  }
}

function setRefreshCookieIfPresent(res: Response, result: LoginResult, config: AuthCookieConfig, ttlSeconds: number): void {
  if (result.refreshToken !== undefined) setRefreshCookie(res, result.refreshToken, new Date(Date.now() + ttlSeconds * 1000), config);
}

function toPublicLoginResult(result: LoginResult): object {
  return {
    success: true,
    accessToken: result.accessToken,
    expiresAt: result.expiresAt.toISOString(),
    user: result.user,
    activeTenant: result.activeTenant,
    availableTenants: result.availableTenants,
    ...(result.mfaRecoveryCodes === undefined ? {} : { mfaRecoveryCodes: result.mfaRecoveryCodes }),
  };
}
