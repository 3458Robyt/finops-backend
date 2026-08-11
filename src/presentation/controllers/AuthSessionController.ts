import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, hashOpaqueToken, type LoginResult } from '../../application/services/AuthService.js';
import { AuthenticationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../auth/authCookie.js';

const switchTenantSchema = z.object({ tenantId: z.string().min(1) });

/** HTTP handlers for the already-authenticated session lifecycle. */
export class AuthSessionController {
  public constructor(private readonly authService: AuthService) {}

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
      this.respondWithAuthError(res, error);
    }
  };

  public switchTenant = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    const parsed = switchTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid switch tenant payload', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await this.authService.switchTenant({
        actor: req.auth,
        tenantId: parsed.data.tenantId,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(req.header('user-agent') === undefined ? {} : { userAgent: req.header('user-agent')! }),
      });
      setRefreshCookieIfPresent(res, result);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public logout = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    try {
      await this.authService.logout(req.auth);
      clearRefreshCookie(res);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public refresh = async (req: Request, res: Response): Promise<void> => {
    const refreshToken = readRefreshCookie(req.header('cookie'));
    if (refreshToken === undefined) {
      clearRefreshCookie(res);
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
      setRefreshCookieIfPresent(res, result);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      clearRefreshCookie(res);
      this.respondWithAuthError(res, error);
    }
  };

  public logoutAll = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    try {
      await this.authService.logoutAll(req.auth);
      clearRefreshCookie(res);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public listSessions = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    try {
      res.status(200).json({ success: true, sessions: await this.authService.listSessions(req.auth) });
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public revokeSession = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) return this.authenticationRequired(res);
    const sessionId = req.params['id'];
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      res.status(400).json({ success: false, error: 'Invalid session id', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      await this.authService.revokeSession(req.auth, sessionId);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  private respondWithAuthError(res: Response, error: unknown): void {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error instanceof FinOpsBaseError) {
      res.status(error.code === 'AUTHORIZATION_FAILED' ? 403 : 500).json({ success: false, error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ success: false, error: 'An unexpected authentication error occurred' });
  }

  private authenticationRequired(res: Response): void {
    res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
  }
}

function setRefreshCookieIfPresent(res: Response, result: LoginResult): void {
  if (result.refreshToken !== undefined) setRefreshCookie(res, result.refreshToken, refreshCookieExpiry());
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

function refreshCookieExpiry(): Date {
  const parsed = Number.parseInt(process.env['AUTH_REFRESH_TOKEN_TTL_SECONDS'] ?? '', 10);
  const seconds = Number.isInteger(parsed) && parsed >= 300 && parsed <= 90 * 24 * 60 * 60 ? parsed : 30 * 24 * 60 * 60;
  return new Date(Date.now() + seconds * 1000);
}
