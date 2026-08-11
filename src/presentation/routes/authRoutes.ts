import { Router } from 'express';
import { AuthController } from '../controllers/AuthController.js';
import type { PasswordRecoveryController } from '../controllers/PasswordRecoveryController.js';
import type { MfaController } from '../controllers/MfaController.js';
import type { RequestHandler } from 'express';

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
  requireAuth: RequestHandler,
  passwordRecoveryController?: PasswordRecoveryController,
  mfaController?: MfaController,
): Router {
  const router = Router();

  router.post('/login', authController.login);
  router.post('/refresh', authController.refresh);
  router.post('/mfa/complete', authController.completeMfa);
  router.post('/mfa/enrollment/complete', authController.completeMfaEnrollment);
  if (passwordRecoveryController !== undefined) {
    router.post('/password-reset/request', passwordRecoveryController.request);
    router.post('/password-reset/confirm', passwordRecoveryController.confirm);
  }
  if (mfaController !== undefined) {
    router.get('/mfa/status', requireAuth, mfaController.status);
    router.post('/mfa/setup', requireAuth, mfaController.setup);
    router.post('/mfa/confirm', requireAuth, mfaController.confirm);
  }
  router.post('/logout', requireAuth, authController.logout);
  router.post('/logout-all', requireAuth, authController.logoutAll);
  router.get('/sessions', requireAuth, authController.listSessions);
  router.delete('/sessions/:id', requireAuth, authController.revokeSession);
  router.get('/tenants', requireAuth, authController.listTenants);
  router.post('/switch-tenant', requireAuth, authController.switchTenant);

  return router;
}
