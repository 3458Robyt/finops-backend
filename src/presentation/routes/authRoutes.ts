import { Router } from 'express';
import { AuthController } from '../controllers/AuthController.js';
import { AuthSessionController } from '../controllers/AuthSessionController.js';
import type { PasswordRecoveryController } from '../controllers/PasswordRecoveryController.js';
import type { MfaController } from '../controllers/MfaController.js';
import type { RequestHandler } from 'express';
import { createTrustedOriginGuard } from '../middleware/trustedOrigin.js';
import type { ClientInvitationController } from '../controllers/ClientInvitationController.js';

/**
 * Construye el router de autenticación.
 *
 * Se monta bajo el prefijo `/api/v1/auth` (ver `server.ts`). A diferencia
 * del resto de routers, este NO aplica el middleware `requireAuth`, ya que
 * el login es el punto de entrada para obtener el token.
 *
 * Endpoints expuestos:
 * | Método | Subruta | Auth | Handler                |
 * |--------|---------|------|------------------------|
 * | POST   | /login  | —    | authController.login   |
 *
 * @param authController Controlador con el handler de login.
 * @returns Router de Express con las rutas de autenticación.
 */
export function createAuthRoutes(
  authController: AuthController,
  authSessionController: AuthSessionController,
  requireAuth: RequestHandler,
  passwordRecoveryController?: PasswordRecoveryController,
  mfaController?: MfaController,
  allowedOrigins: readonly string[] = ['http://localhost:5173'],
  clientInvitationController?: ClientInvitationController,
): Router {
  const router = Router();
  const trustedOrigin = createTrustedOriginGuard(allowedOrigins);

  router.post('/login', authController.login);
  if (clientInvitationController !== undefined) {
    router.post('/client-invitations/accept', trustedOrigin, clientInvitationController.accept);
  }
  router.post('/refresh', trustedOrigin, authSessionController.refresh);
  router.post('/mfa/complete', trustedOrigin, authController.completeMfa);
  router.post('/mfa/enrollment/complete', trustedOrigin, authController.completeMfaEnrollment);
  if (passwordRecoveryController !== undefined) {
    router.post('/password-reset/request', passwordRecoveryController.request);
    router.post('/password-reset/confirm', passwordRecoveryController.confirm);
  }
  if (mfaController !== undefined) {
    router.get('/mfa/status', requireAuth, mfaController.status);
    router.post('/mfa/setup', requireAuth, mfaController.setup);
    router.post('/mfa/confirm', requireAuth, mfaController.confirm);
    router.post('/mfa/recovery-codes/regenerate', requireAuth, mfaController.regenerateRecoveryCodes);
  }
  router.post('/logout', trustedOrigin, requireAuth, authSessionController.logout);
  router.post('/logout-all', trustedOrigin, requireAuth, authSessionController.logoutAll);
  router.get('/sessions', requireAuth, authSessionController.listSessions);
  router.delete('/sessions/:id', requireAuth, authSessionController.revokeSession);
  router.get('/tenants', requireAuth, authSessionController.listTenants);
  router.post('/switch-tenant', trustedOrigin, requireAuth, authSessionController.switchTenant);

  return router;
}
