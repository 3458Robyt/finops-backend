import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, hashOpaqueToken, type LoginResult } from '../../application/services/AuthService.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie, type AuthCookieConfig } from '../auth/authCookie.js';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

const switchTenantSchema = z.object({ tenantId: z.string().min(1) });

/** HTTP handlers for the already-authenticated session lifecycle. */
export class AuthSessionController {
  public constructor(
    private readonly authService: AuthService,
    private readonly cookieConfig: AuthCookieConfig,
    private readonly refreshTokenTtlSeconds: number,
  ) {}

  public listTenants = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    try {
      const tenants = await this.authService.listAccessibleTenants(req.auth);
      res.status(200).json({
        success: true,
        activeTenant: tenants.find((tenant) => tenant.isCurrent) ?? null,
        availableTenants: tenants,
      });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cargar los tenants disponibles.', 'auth_list_tenants', req.path);
    }
  };

  public switchTenant = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    const parsed = switchTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'El tenant seleccionado no es válido.', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await this.authService.switchTenant({
        actor: req.auth,
        tenantId: parsed.data.tenantId,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(req.header('user-agent') === undefined ? {} : { userAgent: req.header('user-agent')! }),
      });
      setRefreshCookieIfPresent(res, result, this.cookieConfig, this.refreshTokenTtlSeconds);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cambiar de tenant.', 'auth_switch_tenant', req.path);
    }
  };

  public logout = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    try {
      await this.authService.logout(req.auth);
      clearRefreshCookie(res, this.cookieConfig);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cerrar la sesión.', 'auth_logout', req.path);
    }
  };

  public refresh = async (req: Request, res: Response): Promise<void> => {
    const refreshToken = readRefreshCookie(req.header('cookie'));
    if (refreshToken === undefined) {
      clearRefreshCookie(res, this.cookieConfig);
      res.status(401).json({ success: false, error: 'La sesión de renovación no está disponible.', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    try {
      const result = await runWithDatabaseContext({
        refreshTokenHash: hashOpaqueToken(refreshToken),
        requestId: res.locals.requestId,
      }, () => this.authService.refresh({
        refreshToken,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(req.header('user-agent') === undefined ? {} : { userAgent: req.header('user-agent')! }),
      }));
      setRefreshCookieIfPresent(res, result, this.cookieConfig, this.refreshTokenTtlSeconds);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      clearRefreshCookie(res, this.cookieConfig);
      respondWithFinOpsError(res, error, 'No fue posible renovar la sesión.', 'auth_refresh', req.path);
    }
  };

  public logoutAll = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    try {
      await this.authService.logoutAll(req.auth);
      clearRefreshCookie(res, this.cookieConfig);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cerrar las sesiones.', 'auth_logout_all', req.path);
    }
  };

  public listSessions = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    try {
      res.status(200).json({ success: true, sessions: await this.authService.listSessions(req.auth) });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible cargar las sesiones.', 'auth_list_sessions', req.path);
    }
  };

  public revokeSession = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    const sessionId = req.params['id'];
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      res.status(400).json({ success: false, error: 'El identificador de sesión no es válido.', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      await this.authService.revokeSession(req.auth, sessionId);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      respondWithFinOpsError(res, error, 'No fue posible revocar la sesión.', 'auth_revoke_session', req.path);
    }
  };

  private authenticationRequired(res: Response): void {
    res.status(401).json({ success: false, error: 'Se requiere autenticación.', code: 'AUTHENTICATION_REQUIRED' });
  }
}

function setRefreshCookieIfPresent(res: Response, result: LoginResult, config: AuthCookieConfig, ttlSeconds: number): void {
  if (result.refreshToken !== undefined) setRefreshCookie(res, result.refreshToken, refreshCookieExpiry(ttlSeconds), config);
}

function toPublicLoginResult(result: LoginResult): object {
  return {
    success: true,
    accessToken: result.accessToken,
    expiresAt: result.expiresAt.toISOString(),
    user: result.user,
    activeTenant: result.activeTenant,
    availableTenants: result.availableTenants,
  };
}

function refreshCookieExpiry(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}
