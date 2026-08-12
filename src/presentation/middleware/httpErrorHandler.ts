import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { respondWithFinOpsError } from '../http/finOpsErrorResponse.js';

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

    respondWithFinOpsError(
      res,
      error,
      'Error interno del servidor',
      'unhandled_http_error',
      `${req.method} ${req.path}`,
    );
  };
}

function isPayloadError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { readonly type?: unknown; readonly status?: unknown };
  return candidate.type === 'entity.parse.failed'
    || candidate.type === 'entity.too.large'
    || candidate.status === 413;
}
