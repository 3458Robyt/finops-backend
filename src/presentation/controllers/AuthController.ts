import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, type LoginResult } from '../../application/services/AuthService.js';
import { hashMfaChallengeToken } from '../../application/services/MfaService.js';
import { isMfaRecoveryCode } from '../../application/services/security/mfaRecoveryCodes.js';
import { AuthenticationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import { setRefreshCookie, type AuthCookieConfig } from '../auth/authCookie.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const mfaCompleteSchema = z.object({
  challengeToken: z.string().min(32),
  code: z.string().min(6).max(32).refine((value) => /^\d{6}$/.test(value) || isMfaRecoveryCode(value)),
});

/** Public credential exchange and pre-session MFA challenge handlers. */
export class AuthController {
  public constructor(
    private readonly authService: AuthService,
    private readonly cookieConfig: AuthCookieConfig,
    private readonly refreshTokenTtlSeconds: number,
  ) {}

  public login = async (req: Request, res: Response): Promise<void> => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid login payload', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const result = await runWithDatabaseContext({
        loginEmail: parsed.data.email,
        requestId: res.locals.requestId,
      }, () => this.authService.login({
        email: parsed.data.email,
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
      this.respondLoginError(res, error);
    }
  };

  public completeMfa = async (req: Request, res: Response): Promise<void> => {
    const parsed = mfaCompleteSchema.safeParse(req.body);
    if (!parsed.success) return this.invalidMfaPayload(res);
    try {
      const result = await runWithDatabaseContext({
        mfaChallengeTokenHash: hashMfaChallengeToken(parsed.data.challengeToken),
        requestId: res.locals.requestId,
      }, () => this.authService.completeMfaLogin({
        challengeToken: parsed.data.challengeToken,
        code: parsed.data.code,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(req.header('user-agent') === undefined ? {} : { userAgent: req.header('user-agent')! }),
      }));
      setRefreshCookieIfPresent(res, result, this.cookieConfig, this.refreshTokenTtlSeconds);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  public completeMfaEnrollment = async (req: Request, res: Response): Promise<void> => {
    const parsed = mfaCompleteSchema.safeParse(req.body);
    if (!parsed.success) return this.invalidMfaPayload(res);
    try {
      const result = await runWithDatabaseContext({
        mfaChallengeTokenHash: hashMfaChallengeToken(parsed.data.challengeToken),
        requestId: res.locals.requestId,
      }, () => this.authService.completeMfaEnrollment({
        challengeToken: parsed.data.challengeToken,
        code: parsed.data.code,
        ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
        ...(req.header('user-agent') === undefined ? {} : { userAgent: req.header('user-agent')! }),
      }));
      setRefreshCookieIfPresent(res, result, this.cookieConfig, this.refreshTokenTtlSeconds);
      res.status(200).json(toPublicLoginResult(result));
    } catch (error: unknown) {
      this.respondWithAuthError(res, error);
    }
  };

  private invalidMfaPayload(res: Response): void {
    res.status(400).json({ success: false, error: 'El desafío MFA no es válido.', code: 'VALIDATION_ERROR' });
  }

  private respondLoginError(res: Response, error: unknown): void {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error instanceof FinOpsBaseError) {
      res.status(500).json({ success: false, error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ success: false, error: 'An unexpected authentication error occurred' });
  }

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
    ...(result.mfaRecoveryCodes === undefined ? {} : { mfaRecoveryCodes: result.mfaRecoveryCodes }),
  };
}

function refreshCookieExpiry(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}
