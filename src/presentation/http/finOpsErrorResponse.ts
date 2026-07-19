import { FinOpsBaseError } from '../../domain/errors/errors.js';

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
