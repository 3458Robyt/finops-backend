import { createHash, randomBytes } from 'node:crypto';
import type { IAccountRecoveryRepository } from '../../domain/interfaces/IAccountRecoveryRepository.js';
import type { IAuthSessionRepository } from '../../domain/interfaces/IAuthSessionRepository.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import { AuthenticationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IEmailClient } from './EmailClient.js';

export interface PasswordResetRequestInput {
  readonly email: string;
  readonly ipAddress?: string;
}

export interface PasswordResetResult {
  readonly accepted: true;
  readonly emailSent: boolean;
}

export class PasswordRecoveryService {
  public constructor(
    private readonly repository: IAccountRecoveryRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly sessions: IAuthSessionRepository,
    private readonly emailClient: IEmailClient,
  ) {}

  public async requestReset(input: PasswordResetRequestInput): Promise<PasswordResetResult> {
    const email = normalizeEmail(input.email);
    const target = await this.repository.findUserByEmail(email);
    if (target === null || target.status !== 'ACTIVE') {
      return { accepted: true, emailSent: false };
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + readResetTtlSeconds() * 1000);
    await this.repository.createPasswordResetToken({
      userId: target.userId,
      tokenHash: hashToken(token),
      expiresAt,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
    });

    if (!this.emailClient.enabled) {
      return { accepted: true, emailSent: false };
    }

    try {
      const resetUrl = `${process.env['PASSWORD_RESET_URL'] ?? 'http://localhost:5173/reset-password'}?token=${encodeURIComponent(token)}`;
      await this.emailClient.send({
        to: target.email,
        subject: 'Restablece tu contraseña de FinOps Inteligente',
        text: [
          `Hola ${target.name},`,
          '',
          'Solicitaste restablecer tu contraseña de FinOps Inteligente.',
          `Usa este enlace antes de ${expiresAt.toISOString()}:`,
          resetUrl,
          '',
          'Si no reconoces esta solicitud, ignora este mensaje.',
        ].join('\n'),
      });
      return { accepted: true, emailSent: true };
    } catch {
      return { accepted: true, emailSent: false };
    }
  }

  public async confirmReset(input: { readonly token: string; readonly password: string }): Promise<void> {
    if (input.token.trim().length < 32) {
      throw new AuthenticationError('El enlace de restablecimiento no es válido o expiró.');
    }
    const password = validatePassword(input.password);
    const target = await this.repository.consumeAndUpdatePassword({
      tokenHash: hashToken(input.token),
      passwordHash: await this.passwordHasher.hash(password),
    });
    if (target === null || target.status !== 'ACTIVE') {
      throw new AuthenticationError('El enlace de restablecimiento no es válido o expiró.');
    }

    await this.sessions.revokeAll(target.userId);
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function validatePassword(value: string): string {
  if (value.length < 12 || value.length > 128) {
    throw new FinOpsBaseError('La contraseña debe contener entre 12 y 128 caracteres.', 'VALIDATION_ERROR');
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new FinOpsBaseError('La contraseña debe incluir minúsculas, mayúsculas y números.', 'VALIDATION_ERROR');
  }
  return value;
}

function readResetTtlSeconds(): number {
  const parsed = Number.parseInt(process.env['PASSWORD_RESET_TTL_SECONDS'] ?? '900', 10);
  return Number.isInteger(parsed) && parsed >= 300 && parsed <= 3600 ? parsed : 900;
}
