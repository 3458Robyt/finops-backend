import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { FinOpsBaseError } from '../../domain/errors/errors.js';

export function createNotFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json({
      success: false,
      error: 'Ruta no encontrada',
      code: 'NOT_FOUND',
      path: req.path,
    });
  };
}

export function createHttpErrorHandler(): (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId = res.locals.requestId as string | undefined;
    if (isPayloadError(error)) {
      res.status(400).json({
        success: false,
        error: 'La solicitud no contiene un JSON válido o excede el tamaño permitido.',
        code: 'INVALID_REQUEST_BODY',
        ...(requestId === undefined ? {} : { diagnosticId: requestId }),
      });
      return;
    }

    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'AUTHENTICATION_FAILED'
        ? 401
        : error.code === 'AUTHORIZATION_FAILED' ? 403 : 500;
      res.status(status).json({
        success: false,
        error: status >= 500 ? 'Error interno del servidor' : error.message,
        code: error.code,
        ...(requestId === undefined ? {} : { diagnosticId: requestId }),
      });
      return;
    }

    console.error(JSON.stringify({
      level: 'error',
      event: 'unhandled_http_error',
      requestId,
      method: req.method,
      path: req.path,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }));
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor',
      code: 'INTERNAL_SERVER_ERROR',
      ...(requestId === undefined ? {} : { diagnosticId: requestId }),
    });
  };
}

function isPayloadError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { readonly type?: unknown; readonly status?: unknown };
  return candidate.type === 'entity.parse.failed'
    || candidate.type === 'entity.too.large'
    || candidate.status === 413;
}
