import type { RequestHandler } from 'express';

/**
 * Protects browser state-changing authentication endpoints when they rely on
 * the HttpOnly refresh cookie. Requests without an Origin header remain
 * possible for CLI/server clients; browser origins must be explicitly listed.
 */
export function createTrustedOriginGuard(): RequestHandler {
  const allowedOrigins = readAllowedOrigins();

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

function readAllowedOrigins(): ReadonlySet<string> {
  const configured = process.env['CORS_ORIGIN']
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  return new Set(configured.length > 0 ? configured : ['http://localhost:5173']);
}
