import type { AuthContext } from '../models/AuthContext.js';

/**
 * Resultado de la emisión de un token de autenticación.
 *
 * Agrupa el token firmado junto con los metadatos necesarios para
 * registrar y revocar la sesión asociada.
 */
export interface TokenIssueResult {
  /** Token firmado (JWT) listo para entregarse al cliente. */
  readonly token: string;
  /** Identificador único del token (claim `jti`); permite rastrear o revocar la sesión. */
  readonly jwtId: string;
  /** Instante de expiración absoluto del token. */
  readonly expiresAt: Date;
}

/**
 * Contrato del servicio de gestión de tokens de autenticación.
 *
 * Puerto de dominio que abstrae la emisión y verificación de tokens (JWT).
 * La implementación concreta (firma, algoritmo, claves) vive en la capa de
 * infraestructura, de modo que los casos de uso dependan de esta abstracción.
 */
export interface ITokenService {
  /**
   * Emite un nuevo token de autenticación para el contexto de sesión indicado.
   *
   * @param context - Datos de autenticación a incluir en el token, sin el `jwtId`
   *                  (este se genera internamente durante la emisión).
   * @returns Token firmado junto con su identificador y fecha de expiración.
   */
  issueToken(context: Omit<AuthContext, 'jwtId'>): TokenIssueResult;

  /**
   * Verifica y decodifica un token, validando firma y vigencia.
   *
   * @param token - Token firmado recibido del cliente.
   * @returns Contexto de autenticación reconstruido a partir del token.
   * @throws Error si el token es inválido, está expirado o su firma no es válida.
   */
  verifyToken(token: string): AuthContext;
}
