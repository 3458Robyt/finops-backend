import type { RequestHandler } from 'express';

/**
 * Protects browser state-changing authentication endpoints when they rely on
 * the HttpOnly refresh cookie. Requests without an Origin header remain
 * possible for CLI/server clients; browser origins must be explicitly listed.
 */
export function createTrustedOriginGuard(configuredOrigins: readonly string[] = ['http://localhost:5173']): RequestHandler {
  const allowedOrigins = new Set(configuredOrigins.filter((origin) => origin.trim().length > 0));

  return (req, res, next): void => {
    const origin = req.header('origin');
    if (origin === undefined) {
      next();
      return;
    }

    if (allowedOrigins.has(origin)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      error: 'El origen de la solicitud no está autorizado.',
      code: 'CSRF_ORIGIN_REJECTED',
    });
  };
}
