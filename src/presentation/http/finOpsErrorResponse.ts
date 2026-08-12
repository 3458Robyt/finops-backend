import type { Response } from 'express';
import { AiAuditRejectedError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { safeErrorMessage } from '../../application/observability/safeError.js';

export function resolveFinOpsError(error: unknown, fallback: string): {
  readonly status: number;
  readonly error: string;
  readonly code?: string;
  readonly diagnosticId?: string;
  readonly audit?: unknown;
} {
  if (error instanceof AiAuditRejectedError) {
    return {
      status: 422,
      error: safeErrorMessage(error.message),
      code: error.code,
      diagnosticId: error.diagnosticId,
      audit: error.audit,
    };
  }

  if (!(error instanceof FinOpsBaseError)) {
    return { status: 500, error: fallback };
  }

  const status = error.code === 'AUTHENTICATION_REQUIRED' ? 401
    : error.code === 'AUTHORIZATION_FAILED' ? 403
      : error.code === 'NOT_FOUND' ? 404
        : error.code === 'VALIDATION_ERROR' ? 400
          : error.code === 'CONFLICT' ? 409
            : ['AI_RESPONSE_ERROR', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT'].includes(error.code) ? 502
            : 500;
  return { status, error: safeErrorMessage(error.message), code: error.code };
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
  const responseDiagnosticId = payload.diagnosticId ?? diagnosticId;
  res.status(status).json({
    success: false,
    ...payload,
    ...(responseDiagnosticId === undefined ? {} : { diagnosticId: responseDiagnosticId }),
  });
}
