import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import type { AuthContext, UserRole } from '../../domain/models/AuthContext.js';
import type { ITokenService, TokenIssueResult } from '../../domain/interfaces/ITokenService.js';
import { AuthenticationError, ConfigurationError } from '../../domain/errors/errors.js';

interface JwtTokenServiceConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly expiresInSeconds: number;
}

interface FinOpsJwtPayload extends JwtPayload {
  readonly tenantId: string;
  readonly email: string;
  readonly role: UserRole;
}

export class JwtTokenService implements ITokenService {
  private readonly config: JwtTokenServiceConfig;

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
