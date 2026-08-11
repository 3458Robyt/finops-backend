export interface EncryptedSecret {
  readonly encryptedPayload: string;
  readonly encryptionIv: string;
  readonly encryptionAuthTag: string;
  readonly encryptionAlgorithm: 'aes-256-gcm';
  readonly encryptionKeyVersion: string;
}

export interface ISecretCipher {
  encrypt(payload: Readonly<Record<string, unknown>>): EncryptedSecret;
  decrypt(payload: EncryptedSecret): Readonly<Record<string, unknown>>;
}
