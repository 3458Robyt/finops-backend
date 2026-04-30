import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CredentialCipher } from './CredentialCipher.js';

describe('CredentialCipher', () => {
  test('round-trips cloud credential payloads with AES-256-GCM', () => {
    const key = randomBytes(32).toString('base64');
    const cipher = new CredentialCipher(key, 'test-key');

    const encrypted = cipher.encrypt({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
    });

    expect(encrypted.encryptedPayload).not.toContain('secret');
    expect(encrypted.encryptionAlgorithm).toBe('aes-256-gcm');
    expect(encrypted.encryptionKeyVersion).toBe('test-key');
    expect(cipher.decrypt(encrypted)).toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
    });
  });
});
