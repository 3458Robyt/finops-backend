import type { Response } from 'express';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import { safeErrorMessage } from '../../application/observability/safeError.js';

export function resolveFinOpsError(error: unknown, fallback: string): {
  readonly status: number;
  readonly error: string;
  readonly code?: string;
} {
  if (!(error instanceof FinOpsBaseError)) {
    return { status: 500, error: fallback };
  }

  const status = error.code === 'AUTHENTICATION_REQUIRED' ? 401
    : error.code === 'AUTHORIZATION_FAILED' ? 403
      : error.code === 'NOT_FOUND' ? 404
        : error.code === 'VALIDATION_ERROR' ? 400
          : error.code === 'CONFLICT' ? 409
            : 500;
  return { status, error: error.message, code: error.code };
}

export function respondWithFinOpsError(
  res: Response,
  error: unknown,
  fallback: string,
  event: string,
  path?: string,
): void {
  const response = resolveFinOpsError(error, fallback);
  const diagnosticId = typeof res.locals?.requestId === 'string' ? res.locals.requestId : undefined;

  if (!(error instanceof FinOpsBaseError)) {
    console.error(JSON.stringify({
      level: 'error',
      event,
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
      ...(path === undefined ? {} : { path }),
      error: safeErrorMessage(error),
    }));
  }

  const { status, ...payload } = response;
  res.status(status).json({
    success: false,
    ...payload,
    ...(diagnosticId === undefined ? {} : { diagnosticId }),
  });
}
