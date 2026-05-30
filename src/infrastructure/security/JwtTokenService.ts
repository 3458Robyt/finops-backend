import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { AuthContext, UserRole } from '../../domain/models/AuthContext.js';
import type { ITokenService, TokenIssueResult } from '../../domain/interfaces/ITokenService.js';
import { AuthenticationError, ConfigurationError } from '../../domain/errors/errors.js';

/**
 * Configuración interna del servicio de tokens JWT, resuelta en el constructor
 * a partir de los parámetros recibidos o de variables de entorno.
 */
interface JwtTokenServiceConfig {
  /** Secreto compartido usado para firmar y verificar tokens HS256. */
  readonly secret: string;
  /** Emisor (`iss`) que se incrusta y valida en los tokens. */
  readonly issuer: string;
  /** Audiencia (`aud`) que se incrusta y valida en los tokens. */
  readonly audience: string;
  /** Tiempo de expiración del token, en segundos. */
  readonly expiresInSeconds: number;
}

/**
 * Forma del payload de los tokens JWT emitidos por este servicio.
 *
 * Extiende el {@link JwtPayload} estándar (que aporta `sub`, `jti`, `exp`, etc.)
 * con los claims específicos del dominio FinOps.
 */
interface FinOpsJwtPayload extends JwtPayload {
  /** Identificador del tenant al que pertenece el usuario. */
  readonly tenantId: string;
  /** Correo electrónico del usuario. */
  readonly email: string;
  /** Rol del usuario dentro del sistema. */
  readonly role: UserRole;
}

/**
 * Adaptador de infraestructura que implementa la interfaz de dominio
 * {@link ITokenService} usando la librería `jsonwebtoken`.
 *
 * Responsabilidad: emitir y verificar tokens de acceso JWT firmados de forma
 * simétrica con el algoritmo **HS256** (HMAC-SHA256).
 *
 * Aspectos de seguridad:
 * - Firma simétrica HS256; el `secret` debe tener **al menos 32 caracteres**.
 * - Cada token incluye un `jti` (JWT ID) aleatorio (`randomUUID`) para permitir
 *   revocación/seguimiento individual.
 * - Se validan emisor (`issuer`), audiencia (`audience`) y caducidad (`exp`).
 * - Expiración por defecto: 15 minutos (900 s) si no se configura.
 */
export class JwtTokenService implements ITokenService {
  private readonly config: JwtTokenServiceConfig;

  /**
   * Construye el servicio resolviendo la configuración desde los parámetros
   * o desde variables de entorno (`JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`,
   * `JWT_EXPIRES_IN_SECONDS`).
   *
   * @param config - Configuración parcial opcional; cualquier campo ausente se
   *   completa con la variable de entorno correspondiente o un valor por defecto
   *   (`issuer` = `finops-backend`, `audience` = `finops-app`, expiración = 900 s).
   * @throws {ConfigurationError} Si el secreto no está definido o tiene menos de 32 caracteres.
   * @throws {ConfigurationError} Si `JWT_EXPIRES_IN_SECONDS` está presente pero no es un entero positivo.
   */
  constructor(config?: Partial<JwtTokenServiceConfig>) {
    const secret = config?.secret ?? process.env['JWT_SECRET'];

    if (secret === undefined || secret.length < 32) {
      throw new ConfigurationError('JWT_SECRET must be configured with at least 32 characters');
    }

    this.config = {
      secret,
      issuer: config?.issuer ?? process.env['JWT_ISSUER'] ?? 'finops-backend',
      audience: config?.audience ?? process.env['JWT_AUDIENCE'] ?? 'finops-app',
      expiresInSeconds: config?.expiresInSeconds ?? this.readExpirySeconds(),
    };
  }

  /**
   * Emite un nuevo token JWT firmado para el contexto de autenticación dado.
   *
   * Genera un `jti` único, calcula el instante de expiración y firma el payload
   * con HS256 incluyendo `issuer`, `audience` y `expiresIn`.
   *
   * @param context - Contexto de autenticación del usuario, sin el campo `jwtId`
   *   (este se genera internamente).
   * @returns {@link TokenIssueResult} con el token firmado, el `jwtId` generado
   *   y la fecha de expiración (`expiresAt`).
   */
  public issueToken(context: Omit<AuthContext, 'jwtId'>): TokenIssueResult {
    const jwtId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + this.config.expiresInSeconds) * 1000);

    const payload: FinOpsJwtPayload = {
      sub: context.userId,
      tenantId: context.tenantId,
      email: context.email,
      role: context.role,
    };

    const options: SignOptions = {
      algorithm: 'HS256',
      issuer: this.config.issuer,
      audience: this.config.audience,
      jwtid: jwtId,
      expiresIn: this.config.expiresInSeconds,
    };

    return {
      token: jwt.sign(payload, this.config.secret, options),
      jwtId,
      expiresAt,
    };
  }

  /**
   * Verifica la firma y los claims de un token JWT y reconstruye el contexto
   * de autenticación del dominio.
   *
   * Valida algoritmo (`HS256`), emisor, audiencia y caducidad, y comprueba que
   * los claims obligatorios (`sub`, `jti`, `tenantId`, `email`, `role`) estén
   * presentes y bien tipados. El `role` debe ser `ADMIN` o `VIEWER`.
   *
   * @param token - Token JWT en formato compacto a verificar.
   * @returns El {@link AuthContext} reconstruido a partir de los claims.
   * @throws {AuthenticationError} Si el payload es un string, si faltan o son
   *   inválidos los claims requeridos, o si el token es inválido o ha expirado.
   */
  public verifyToken(token: string): AuthContext {
    try {
      const decoded = jwt.verify(token, this.config.secret, {
        algorithms: ['HS256'],
        issuer: this.config.issuer,
        audience: this.config.audience,
      });

      if (typeof decoded === 'string') {
        throw new AuthenticationError('Invalid token payload');
      }

      const payload = decoded as FinOpsJwtPayload;

      if (
        typeof payload.sub !== 'string' ||
        typeof payload.jti !== 'string' ||
        typeof payload.tenantId !== 'string' ||
        typeof payload.email !== 'string' ||
        (payload.role !== 'ADMIN' && payload.role !== 'VIEWER')
      ) {
        throw new AuthenticationError('Invalid token claims');
      }

      return {
        userId: payload.sub,
        tenantId: payload.tenantId,
        email: payload.email,
        role: payload.role,
        jwtId: payload.jti,
      };
    } catch (error: unknown) {
      if (error instanceof AuthenticationError) {
        throw error;
      }

      throw new AuthenticationError('Invalid or expired token');
    }
  }

  /**
   * Lee y valida el tiempo de expiración (en segundos) desde la variable de
   * entorno `JWT_EXPIRES_IN_SECONDS`.
   *
   * @returns El número de segundos configurado, o 900 (15 minutos) si la
   *   variable no está definida.
   * @throws {ConfigurationError} Si el valor existe pero no es un entero positivo finito.
   */
  private readExpirySeconds(): number {
    const raw = process.env['JWT_EXPIRES_IN_SECONDS'];

    if (raw === undefined) {
      return 15 * 60;
    }

    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigurationError('JWT_EXPIRES_IN_SECONDS must be a positive integer');
    }

    return parsed;
  }
}
