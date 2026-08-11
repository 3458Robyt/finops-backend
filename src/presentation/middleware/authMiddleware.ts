import type { NextFunction, Request, Response } from 'express';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { IAuthSessionRepository } from '../../domain/interfaces/IAuthSessionRepository.js';
import type { UserRole } from '../../domain/models/AuthContext.js';
import { AuthenticationError, AuthorizationError } from '../../domain/errors/errors.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';

/**
 * Crea el middleware de autenticación basado en Bearer token.
 *
 * Flujo:
 *   1. Lee la cabecera `Authorization`.
 *   2. Si falta o no empieza por `Bearer `, responde `401` con código
 *      `AUTHENTICATION_REQUIRED` y mensaje `Missing Bearer token`.
 *   3. Verifica el token con `tokenService.verifyToken` y, si es válido,
 *      rellena `req.auth` con el `AuthContext` resultante y llama a `next()`.
 *   4. Si la verificación lanza una excepción, responde `401` con código
 *      `AUTHENTICATION_FAILED` y mensaje `Invalid or expired token`.
 *
 * @param tokenService Servicio de tokens usado para verificar el JWT.
 * @returns Middleware de Express que protege rutas exigiendo un token válido.
 */
export function createAuthMiddleware(
  tokenService: ITokenService,
  sessionRepository: IAuthSessionRepository,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization');

    if (header === undefined || !header.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Missing Bearer token',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    try {
      const auth = tokenService.verifyToken(header.slice('Bearer '.length).trim());
      const databaseContext = {
        tenantId: auth.tenantId,
        userId: auth.userId,
        role: auth.role,
        requestId: res.locals.requestId,
      } as const;
      const active = await runWithDatabaseContext(
        databaseContext,
        () => sessionRepository.isActive(auth),
      );
      if (!active) {
        throw new AuthenticationError('La sesión no está activa. Inicia sesión nuevamente.');
      }

      req.auth = auth;
      runWithDatabaseContext(databaseContext, next);
    } catch {
      res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
        code: 'AUTHENTICATION_FAILED',
      });
    }
  };
}

/**
 * Crea un middleware de autorización por rol.
 *
 * Debe encadenarse DESPUÉS de `createAuthMiddleware`, ya que depende de que
 * `req.auth` esté presente. Comportamiento:
 *   - Si `req.auth` es `undefined` (no autenticado), responde `401` con
 *     código `AUTHENTICATION_REQUIRED` y mensaje `Authentication is required`.
 *   - Si el rol de `req.auth.role` no está en `allowedRoles`, responde `403`
 *     con el mensaje y código del `AuthorizationError` del dominio.
 *   - En caso contrario, llama a `next()`.
 *
 * @param allowedRoles Lista de roles autorizados a acceder a la ruta.
 * @returns Middleware de Express que restringe el acceso según el rol.
 */
export function requireRole(allowedRoles: readonly UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.auth === undefined) {
      res.status(401).json({
        success: false,
        error: 'Authentication is required',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    if (!allowedRoles.includes(req.auth.role)) {
      const error = new AuthorizationError();
      res.status(403).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    next();
  };
}
