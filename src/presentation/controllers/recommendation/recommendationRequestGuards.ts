import type { Request, Response } from 'express';
import type { AuthContext } from '../../../domain/models/AuthContext.js';
import { AuthorizationError } from '../../../domain/errors/errors.js';
import { parseString } from './recommendationRequestParsers.js';

/**
 * Guardas de petición reutilizables para el controlador de recomendaciones
 * FinOps.
 *
 * Centralizan las validaciones de acceso y de entrada básica que se repiten en
 * varios handlers (autenticación, rol de administrador y presencia del
 * identificador de recomendación). Cada guarda, ante un fallo, escribe la
 * respuesta de error HTTP correspondiente y comunica al handler que debe
 * abortar; en caso de éxito devuelve el valor ya validado.
 *
 * Importante: este módulo no importa desde el controlador (solo desde los
 * parsers puros y el dominio), evitando dependencias circulares.
 */

/**
 * Garantiza que la petición está autenticada.
 *
 * Si `req.auth` no está presente, responde 401 con
 * `{ success: false, error, code: 'AUTHENTICATION_REQUIRED' }` y devuelve
 * `undefined` para que el handler aborte; en caso contrario devuelve el
 * {@link AuthContext} autenticado.
 */
export function requireAuth(req: Request, res: Response): AuthContext | undefined {
  if (req.auth === undefined) {
    res.status(401).json({
      success: false,
      error: 'Authentication is required',
      code: 'AUTHENTICATION_REQUIRED',
    });
    return undefined;
  }

  return req.auth;
}

/**
 * Permite administrar la ejecución manual solo a roles operativos FinOps.
 */
export function requireRecommendationExecutionRole(res: Response, auth: AuthContext): boolean {
  return requireRecommendationRole(res, auth, ['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN']);
}

/** Permite aprobar o rechazar a los roles operativos y al aprobador del cliente. */
export function requireRecommendationDecisionRole(res: Response, auth: AuthContext): boolean {
  return requireRecommendationRole(res, auth, ['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN', 'CLIENT_APPROVER']);
}

function requireRecommendationRole(
  res: Response,
  auth: AuthContext,
  allowedRoles: readonly AuthContext['role'][],
): boolean {
  if (!allowedRoles.includes(auth.role)) {
    const error = new AuthorizationError();
    res.status(403).json({
      success: false,
      error: error.message,
      code: error.code,
    });
    return false;
  }

  return true;
}

/**
 * Valida la presencia del identificador de recomendación (normalmente
 * `req.params.id`).
 *
 * Si el valor no es una cadena no vacía, responde 400 con
 * `{ success: false, error, code: 'VALIDATION_ERROR' }` y devuelve `undefined`
 * para que el handler aborte; en caso contrario devuelve el id normalizado.
 */
export function requireRecommendationId(res: Response, value: unknown): string | undefined {
  const recommendationId = parseString(value);

  if (recommendationId === undefined) {
    res.status(400).json({
      success: false,
      error: 'Recommendation id is required',
      code: 'VALIDATION_ERROR',
    });
    return undefined;
  }

  return recommendationId;
}
