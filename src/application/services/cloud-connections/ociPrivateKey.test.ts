import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { CloudConnectionSummary } from '../../../domain/models/CloudConnection.js';
import { normalizeOperationalCredential } from './CloudConnectionInputPolicy.js';
import { inspectOciPrivateKey, normalizeAndValidateOciPrivateKey } from './ociPrivateKey.js';

const ociConnection: CloudConnectionSummary = {
  id: 'connection-oci',
  tenantId: 'tenant-1',
  providerCode: 'oci',
  rootExternalId: 'ocid1.tenancy.example',
  name: 'OCI test',
  status: 'ACTIVE',
  defaultRegion: 'us-ashburn-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function createPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('OCI private key input policy', () => {
  test('normalizes literal escaped line breaks before persistence', () => {
    const pem = createPrivateKeyPem();
    const result = normalizeOperationalCredential(ociConnection, {
      tenancyId: ociConnection.rootExternalId,
      userId: 'ocid1.user.example',
      privateKey: pem.replace(/\r?\n/g, '\\n'),
    });

    expect(result.payload.privateKey).toBe(pem.trim());
    expect(result.payload.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });

  test('accepts CRLF PEM input and preserves no secret in validation errors', () => {
    const pem = createPrivateKeyPem().replace(/\n/g, '\r\n');
    const normalized = normalizeAndValidateOciPrivateKey(pem);

    expect(normalized).not.toContain('\r');
    expect(normalized.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  test('rejects a missing or mismatched PEM footer before the SDK is called', () => {
    const pem = createPrivateKeyPem();
    const malformed = pem.replace('-----END PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----');

    expect(() => normalizeAndValidateOciPrivateKey(malformed)).toThrow(
      'PEM completo con encabezado y pie coincidentes',
    );
  });

  test('validates encrypted PEM keys with the supplied passphrase', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encrypted = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'synthetic-test-passphrase',
    }).toString();

    expect(normalizeAndValidateOciPrivateKey(encrypted, 'synthetic-test-passphrase'))
      .toContain('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    expect(() => normalizeAndValidateOciPrivateKey(encrypted, 'wrong-passphrase'))
      .toThrow('no es válida o la passphrase no coincide');
  });

  test('accepts the OCI_API_KEY marker and removes it before persistence', () => {
    const pem = createPrivateKeyPem();
    const inspected = inspectOciPrivateKey(`${pem}\nOCI_API_KEY`);

    expect(inspected.normalizedPrivateKey).toBe(pem.trim());
    expect(inspected.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });

  test('rejects a supplied fingerprint that does not belong to the private key', () => {
    const pem = createPrivateKeyPem();
    expect(() => normalizeOperationalCredential(ociConnection, {
      tenancyId: ociConnection.rootExternalId,
      userId: 'ocid1.user.example',
      fingerprint: '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff',
      privateKey: pem,
    })).toThrow(/no coincide/i);
  });
});
