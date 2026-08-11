import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AuthService,
  hashOpaqueToken,
  type LoginResult,
} from '../../application/services/AuthService.js';
import { hashMfaChallengeToken } from '../../application/services/MfaService.js';
import { AuthenticationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../auth/authCookie.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const switchTenantSchema = z.object({
  tenantId: z.string().min(1),
});

const mfaCompleteSchema = z.object({
  challengeToken: z.string().min(32),
  code: z.string().regex(/^\d{6}$/),
});

/**
 * Controlador de la capa de presentación para la autenticación (montado en
 * `/api/v1/auth`). Traduce las peticiones HTTP de login hacia el caso de uso de
 * autenticación y serializa el token y los datos de usuario en la respuesta.
 *
 * A diferencia de otros controladores, sus endpoints NO requieren autenticación
 * previa, ya que el login es el punto de entrada para obtener el token.
 *
 * Servicios que utiliza:
 * - {@link AuthService}: valida credenciales y emite el token de acceso.
 */
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Autentica a un usuario por email y contraseña y devuelve un token de acceso.
   *
   * Sirve: POST /api/v1/auth/login
   * Autenticación: no requerida (endpoint público de entrada).
   *
   * Cuerpo (`req.body`, validado con `loginSchema`):
   * - `email`: correo electrónico válido.
   * - `password`: contraseña (no vacía).
   *
   * Además registra el contexto de la petición para auditoría: `req.ip`
   * (dirección IP) y la cabecera `user-agent`, cuando están disponibles.
   *
   * Respuestas:
   * - 200: `{ success: true, accessToken, expiresAt, user }` con el token y su caducidad (ISO).
   * - 400 VALIDATION_ERROR: el cuerpo no cumple el esquema.
   * - 401: credenciales inválidas ({@link AuthenticationError}).
   * - 500: error de dominio no relacionado con credenciales o error inesperado.
   */
  public login = async (req: Request, res: Response): Promise<void> => {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid login payload',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const userAgent = req.header('user-agent');
      const result = await runWithDatabaseContext({
        loginEmail: parsed.data.email,
        requestId: res.locals.requestId,
      }, () => this.authService.login({
        email: parsed.data.email,
        password: parsed.data.password,
        ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
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

      this.setRefreshCookieIfPresent(res, result);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      if (error instanceof AuthenticationError) {
        res.status(401).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      if (error instanceof FinOpsBaseError) {
        res.status(500).json({
          success: false,
          error: error.message,
          code: error.code,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'An unexpected authentication error occurred',
      });
    }
  };

  public listTenants = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

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
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    const parsed = switchTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid switch tenant payload',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const userAgent = req.header('user-agent');
      const result = await this.authService.switchTenant({
        actor: req.auth,
        tenantId: parsed.data.tenantId,
        ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      });

      this.setRefreshCookieIfPresent(res, result);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public completeMfa = async (req: Request, res: Response): Promise<void> => {
    const parsed = mfaCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'El desafío MFA no es válido.', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const userAgent = req.header('user-agent');
      const result = await runWithDatabaseContext({
        mfaChallengeTokenHash: hashMfaChallengeToken(parsed.data.challengeToken),
        requestId: res.locals.requestId,
      }, () => this.authService.completeMfaLogin({
        challengeToken: parsed.data.challengeToken,
        code: parsed.data.code,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(userAgent === undefined ? {} : { userAgent }),
      }));
      this.setRefreshCookieIfPresent(res, result);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public completeMfaEnrollment = async (req: Request, res: Response): Promise<void> => {
    const parsed = mfaCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'El desafío MFA no es válido.', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const userAgent = req.header('user-agent');
      const result = await runWithDatabaseContext({
        mfaChallengeTokenHash: hashMfaChallengeToken(parsed.data.challengeToken),
        requestId: res.locals.requestId,
      }, () => this.authService.completeMfaEnrollment({
        challengeToken: parsed.data.challengeToken,
        code: parsed.data.code,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(userAgent === undefined ? {} : { userAgent }),
      }));
      this.setRefreshCookieIfPresent(res, result);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public logout = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      this.authenticationRequired(res);
      return;
    }

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
      res.status(401).json({
        success: false,
        error: 'La sesión de renovación no está disponible.',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    try {
      const userAgent = req.header('user-agent');
      const result = await runWithDatabaseContext({
        refreshTokenHash: hashOpaqueToken(refreshToken),
        requestId: res.locals.requestId,
      }, () => this.authService.refresh({
        refreshToken,
        ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      }));

      this.setRefreshCookieIfPresent(res, result);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      clearRefreshCookie(res);
      this.respondWithAuthError(res, error);
    }
  };

  public logoutAll = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      this.authenticationRequired(res);
      return;
    }

    try {
      await this.authService.logoutAll(req.auth);
      clearRefreshCookie(res);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public listSessions = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      this.authenticationRequired(res);
      return;
    }

    try {
      const sessions = await this.authService.listSessions(req.auth);
      res.status(200).json({ success: true, sessions });
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public revokeSession = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      this.authenticationRequired(res);
      return;
    }

    const sessionId = req.params['id'];
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      res.status(400).json({
        success: false,
        error: 'Invalid session id',
        code: 'VALIDATION_ERROR',
      });
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
      res.status(401).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'AUTHORIZATION_FAILED' ? 403 : 500;
      res.status(status).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'An unexpected authentication error occurred',
    });
  }

  private authenticationRequired(res: Response): void {
    res.status(401).json({
      success: false,
      error: 'Authentication is required',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }

  private setRefreshCookieIfPresent(res: Response, result: LoginResult): void {
    if (result.refreshToken !== undefined) {
      setRefreshCookie(res, result.refreshToken, refreshCookieExpiry());
    }
  }
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
  const raw = process.env['AUTH_REFRESH_TOKEN_TTL_SECONDS'];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const seconds = Number.isInteger(parsed) && parsed >= 300 && parsed <= 90 * 24 * 60 * 60
    ? parsed
    : 30 * 24 * 60 * 60;
  return new Date(Date.now() + seconds * 1000);
}
