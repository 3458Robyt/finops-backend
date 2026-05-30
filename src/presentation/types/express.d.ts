import type { AuthContext } from '../../domain/models/AuthContext.js';

/**
 * Extensión de tipos (declaration merging) de Express.
 *
 * Añade la propiedad `auth` a `Express.Request` para transportar el
 * contexto de autenticación (`AuthContext`) que rellena el middleware
 * `createAuthMiddleware` tras verificar el Bearer token.
 *
 * Es opcional (`auth?`) porque la propiedad no existe hasta que el
 * middleware de autenticación se ejecuta: en rutas públicas (p. ej.
 * `/api/v1/auth/login` o el webhook de Telegram) y antes de dicho
 * middleware, `req.auth` permanece `undefined`.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
