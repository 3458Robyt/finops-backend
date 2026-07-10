import { Router } from 'express';
import { AuthController } from '../controllers/AuthController.js';
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
export function createAuthRoutes(authController: AuthController, requireAuth: RequestHandler): Router {
  const router = Router();

  router.post('/login', authController.login);
  router.get('/tenants', requireAuth, authController.listTenants);
  router.post('/switch-tenant', requireAuth, authController.switchTenant);

  return router;
}
