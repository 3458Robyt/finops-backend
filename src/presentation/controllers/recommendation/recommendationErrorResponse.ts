import type { Response } from 'express';
import { AiAuditRejectedError, FinOpsBaseError } from '../../../domain/errors/errors.js';
import { safeErrorMessage } from '../../../application/observability/safeError.js';

/**
 * Helper puro de mapeo de errores a respuestas HTTP para el controlador de
 * recomendaciones FinOps.
 *
 * Centraliza la traducción de excepciones de dominio ({@link FinOpsBaseError})
 * a códigos de estado HTTP y la serialización de la respuesta de error, de modo
 * que los handlers del controlador puedan delegar el manejo de errores sin
 * duplicar el mapeo.
 *
 * Importante: este módulo no importa desde el controlador, evitando
 * dependencias circulares.
 */

/**
 * Manejador centralizado de errores que traduce excepciones de dominio a
 * códigos de estado HTTP:
 * - {@link FinOpsBaseError} con código `NOT_FOUND` -> 404; `AUTHORIZATION_FAILED`
 *   -> 403; `AI_AUDIT_REJECTED` -> 409; cualquier otro código -> 400.
 * - Error no controlado -> 500 con `fallbackMessage`.
 */
export function respondWithRecommendationError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof FinOpsBaseError) {
    const status = error.code === 'NOT_FOUND'
      ? 404
      : error.code === 'AUTHORIZATION_FAILED'
        ? 403
        : error.code === 'AI_AUDIT_REJECTED'
          ? 409
          : 400;

    res.status(status).json({
      success: false,
      error: safeErrorMessage(error.message),
      code: error.code,
      ...(error instanceof AiAuditRejectedError
        ? {
            diagnosticId: error.diagnosticId,
            audit: summarizeAudit(error.audit),
          }
        : {}),
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: safeErrorMessage(fallbackMessage),
  });
}

function summarizeAudit(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const audit = value as Record<string, unknown>;
  return {
    verdict: audit['verdict'],
    score: audit['score'],
    blockingIssues: readStrings(audit['blockingIssues']),
    requiredChanges: readStrings(audit['requiredChanges']),
    failedChecks: Array.isArray(audit['checks'])
      ? audit['checks'].flatMap((item) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
          const check = item as Record<string, unknown>;
          return check['passed'] === false
            ? [{ name: check['name'], notes: safeErrorMessage(String(check['notes'] ?? '')) }]
            : [];
        })
      : [],
  };
}

function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(safeErrorMessage)
    : [];
}
