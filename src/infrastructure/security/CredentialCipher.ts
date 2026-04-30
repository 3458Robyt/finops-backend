import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigurationError } from '../../domain/errors/errors.js';

export interface EncryptedCredentialPayload {
  readonly encryptedPayload: string;
  readonly encryptionIv: string;
  readonly encryptionAuthTag: string;
  readonly encryptionAlgorithm: 'aes-256-gcm';
  readonly encryptionKeyVersion: string;
}

export class CredentialCipher {
  private readonly key: Buffer;
  private readonly keyVersion: string;

  constructor(rawKey = process.env['CREDENTIAL_ENCRYPTION_KEY'], keyVersion = process.env['CREDENTIAL_KEY_VERSION'] ?? 'v1') {
    if (rawKey === undefined || rawKey.trim() === '') {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY must be configured as a base64 32-byte key');
    }

    const key = Buffer.from(rawKey, 'base64');

    if (key.length !== 32) {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }

    this.key = key;
    this.keyVersion = keyVersion;
  }

  public encrypt(payload: Readonly<Record<string, unknown>>): EncryptedCredentialPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      encryptedPayload: encrypted.toString('base64'),
      encryptionIv: iv.toString('base64'),
      encryptionAuthTag: cipher.getAuthTag().toString('base64'),
      encryptionAlgorithm: 'aes-256-gcm',
      encryptionKeyVersion: this.keyVersion,
    };
  }

  public decrypt(encrypted: EncryptedCredentialPayload): Readonly<Record<string, unknown>> {
    const decipher = createDecipheriv(
      encrypted.encryptionAlgorithm,
      this.key,
      Buffer.from(encrypted.encryptionIv, 'base64'),
    );

    decipher.setAuthTag(Buffer.from(encrypted.encryptionAuthTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.encryptedPayload, 'base64')),
      decipher.final(),
    ]);

    const parsed: unknown = JSON.parse(decrypted.toString('utf8'));

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Decrypted credential payload is not an object');
    }

    return parsed as Readonly<Record<string, unknown>>;
  }
}
