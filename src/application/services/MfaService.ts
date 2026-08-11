import { randomBytes } from 'node:crypto';
import type { IMfaRepository, MfaRecord } from '../../domain/interfaces/IMfaRepository.js';
import type { ISecretCipher } from '../../domain/interfaces/ISecretCipher.js';
import type { IMfaAuthenticationService, MfaLoginChallenge } from '../../domain/interfaces/IMfaAuthenticationService.js';
import { AuthenticationError, ConfigurationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from './security/totp.js';
import { hashOpaqueToken } from '../auth/opaqueToken.js';

export class MfaService implements IMfaAuthenticationService {
  public constructor(
    private readonly repository: IMfaRepository,
    private readonly cipher?: ISecretCipher,
  ) {}

  public async isEnabled(userId: string): Promise<boolean> {
    const record = await this.repository.findMfa(userId);
    return record?.enabledAt !== undefined;
  }

  public async createLoginChallenge(input: {
    readonly userId: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<MfaLoginChallenge> {
    if (!(await this.isEnabled(input.userId))) {
      throw new AuthenticationError('La autenticación multifactor no está configurada.');
    }
    return this.createChallenge(input.userId, 'LOGIN', input.ipAddress, input.userAgent);
  }

  public async verifyLoginChallenge(challengeToken: string, code: string): Promise<string> {
    return this.verifyChallenge(challengeToken, code, 'LOGIN');
  }

  public async beginSetup(userId: string, email: string): Promise<{ readonly secret: string; readonly otpauthUri: string }> {
    const secret = generateTotpSecret();
    const encrypted = this.encryptSecret(secret);
    await this.repository.savePendingMfa({
      userId,
      encryptedSecret: encrypted.encryptedPayload,
      encryptionIv: encrypted.encryptionIv,
      encryptionAuthTag: encrypted.encryptionAuthTag,
      encryptionAlgorithm: encrypted.encryptionAlgorithm,
      encryptionKeyVersion: encrypted.encryptionKeyVersion,
    });
    return { secret, otpauthUri: buildTotpUri(secret, email) };
  }

  public async confirmSetup(userId: string, code: string): Promise<void> {
    const record = await this.requireMfaRecord(userId);
    const secret = this.decryptSecret(record);
    const usedStep = verifyTotpCode(secret, code);
    if (usedStep === null || record.lastUsedStep !== undefined && BigInt(usedStep) <= record.lastUsedStep) {
      throw new AuthenticationError('El código MFA no es válido o ya fue utilizado.');
    }
    const enabled = await this.repository.enableMfa({
      challengeTokenHash: '',
      userId,
      usedStep: BigInt(usedStep),
      enableMfa: true,
    });
    if (!enabled) throw new AuthenticationError('No se pudo activar MFA. Intenta nuevamente.');
  }

  public async beginEnrollment(input: {
    readonly userId: string;
    readonly email: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<{ readonly challengeToken: string; readonly expiresAt: Date; readonly secret: string; readonly otpauthUri: string }> {
    const setup = await this.beginSetup(input.userId, input.email);
    const challenge = await this.createChallenge(input.userId, 'ENROLLMENT', input.ipAddress, input.userAgent);
    return { ...challenge, ...setup };
  }

  public async completeEnrollment(challengeToken: string, code: string): Promise<string> {
    return this.verifyChallenge(challengeToken, code, 'ENROLLMENT');
  }

  private async verifyChallenge(
    challengeToken: string,
    code: string,
    purpose: 'LOGIN' | 'ENROLLMENT',
  ): Promise<string> {
    if (challengeToken.trim().length < 32) {
      throw new AuthenticationError('El desafío MFA no es válido o expiró.');
    }
    const tokenHash = hashMfaChallengeToken(challengeToken);
    const challenge = await this.repository.findChallenge(tokenHash);
    if (
      challenge === null
      || challenge.purpose !== purpose
      || challenge.consumedAt !== undefined
      || challenge.expiresAt <= new Date()
    ) {
      throw new AuthenticationError('El desafío MFA no es válido o expiró.');
    }

    const record = await this.requireMfaRecord(challenge.userId);
    const secret = this.decryptSecret(record);
    const usedStep = verifyTotpCode(secret, code);
    if (usedStep === null || record.lastUsedStep !== undefined && BigInt(usedStep) <= record.lastUsedStep) {
      throw new AuthenticationError('El código MFA no es válido o ya fue utilizado.');
    }

    const consumed = await this.repository.consumeChallenge({
      challengeTokenHash: tokenHash,
      userId: challenge.userId,
      usedStep: BigInt(usedStep),
      enableMfa: purpose === 'ENROLLMENT',
    });
    if (!consumed) throw new AuthenticationError('El desafío MFA ya no está activo.');
    return challenge.userId;
  }

  private async createChallenge(
    userId: string,
    purpose: 'LOGIN' | 'ENROLLMENT',
    ipAddress?: string,
    userAgent?: string,
  ): Promise<MfaLoginChallenge> {
    const challengeToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await this.repository.createChallenge({
      userId,
      tokenHash: hashMfaChallengeToken(challengeToken),
      purpose,
      expiresAt,
      ...(ipAddress === undefined ? {} : { ipAddress }),
      ...(userAgent === undefined ? {} : { userAgent }),
    });
    return { challengeToken, expiresAt };
  }

  private encryptSecret(secret: string) {
    if (this.cipher === undefined) {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY es necesaria para activar MFA.');
    }
    return this.cipher.encrypt({ secret });
  }

  private decryptSecret(record: MfaRecord): string {
    if (this.cipher === undefined) {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY es necesaria para validar MFA.');
    }
    const payload = this.cipher.decrypt({
      encryptedPayload: record.encryptedSecret,
      encryptionIv: record.encryptionIv,
      encryptionAuthTag: record.encryptionAuthTag,
      encryptionAlgorithm: record.encryptionAlgorithm as 'aes-256-gcm',
      encryptionKeyVersion: record.encryptionKeyVersion,
    });
    const secret = payload['secret'];
    if (typeof secret !== 'string' || secret.trim() === '') {
      throw new FinOpsBaseError('El secreto MFA almacenado no es válido.', 'SECURITY_CONFIGURATION_ERROR');
    }
    return secret;
  }

  private async requireMfaRecord(userId: string): Promise<MfaRecord> {
    const record = await this.repository.findMfa(userId);
    if (record === null) throw new AuthenticationError('MFA no está configurado para este usuario.');
    return record;
  }
}

export const hashMfaChallengeToken = hashOpaqueToken;
