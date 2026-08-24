import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';

const PEM_LABELS = new Set([
  'PRIVATE KEY',
  'ENCRYPTED PRIVATE KEY',
  'RSA PRIVATE KEY',
]);

const PEM_HEADER_PATTERN = /^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----$/;
const PEM_FOOTER_PATTERN = /^-----END ([A-Z0-9 ]*PRIVATE KEY)-----$/;
const OCI_API_KEY_MARKER = 'OCI_API_KEY';
const OCI_FINGERPRINT_PATTERN = /^[0-9a-f]{2}(?::[0-9a-f]{2}){15}$/i;

export interface OciPrivateKeyInspection {
  readonly normalizedPrivateKey: string;
  readonly fingerprint: string;
  readonly keyType: string;
  readonly modulusLength: number;
}

/**
 * Normalizes and cryptographically validates an OCI private key before it is
 * encrypted and persisted. The OCI SDK otherwise reports a low-level PEM
 * footer error much later, during connection validation.
 */
export function normalizeAndValidateOciPrivateKey(
  privateKey: string,
  passphrase?: string,
): string {
  return inspectOciPrivateKey(privateKey, passphrase).normalizedPrivateKey;
}

/**
 * OCI fingerprints are MD5 over the DER-encoded public SubjectPublicKeyInfo,
 * represented as sixteen lowercase hexadecimal pairs separated by colons.
 * The optional OCI_API_KEY marker is accepted as a copy/paste convenience but
 * is removed before the SDK receives the PEM.
 */
export function inspectOciPrivateKey(
  privateKey: string,
  passphrase?: string,
): OciPrivateKeyInspection {
  const normalized = normalizePemLineBreaks(privateKey);
  const lines = normalized.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.at(-1)?.trim() === OCI_API_KEY_MARKER) lines.pop();
  const header = lines[0]?.trim() ?? '';
  const footer = lines.at(-1)?.trim() ?? '';
  const headerMatch = PEM_HEADER_PATTERN.exec(header);
  const footerMatch = PEM_FOOTER_PATTERN.exec(footer);
  const headerLabel = headerMatch?.[1];
  const footerLabel = footerMatch?.[1];

  if (
    headerLabel === undefined
    || footerLabel === undefined
    || headerLabel !== footerLabel
    || !PEM_LABELS.has(headerLabel)
    || lines.slice(1, -1).join('').trim() === ''
  ) {
    throw new FinOpsBaseError(
      'La clave privada OCI debe ser un PEM completo con encabezado y pie coincidentes.',
      'VALIDATION_ERROR',
    );
  }

  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey({
      key: lines.join('\n'),
      format: 'pem',
      ...(passphrase !== undefined ? { passphrase } : {}),
    });
  } catch {
    throw new FinOpsBaseError(
      'La clave privada OCI no es válida o la passphrase no coincide.',
      'VALIDATION_ERROR',
    );
  }

  if (key.asymmetricKeyType !== 'rsa') {
    throw new FinOpsBaseError(
      'OCI requiere una clave privada RSA; las claves EC o DSA no son compatibles.',
      'VALIDATION_ERROR',
    );
  }

  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < 2048) {
    throw new FinOpsBaseError(
      'La clave privada RSA de OCI debe tener al menos 2048 bits.',
      'VALIDATION_ERROR',
    );
  }

  const publicKeyDer = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const fingerprint = formatOciFingerprint(createHash('md5').update(publicKeyDer).digest('hex'));
  return {
    normalizedPrivateKey: lines.join('\n'),
    fingerprint,
    keyType: key.asymmetricKeyType,
    modulusLength,
  };
}

export function normalizeOciFingerprint(value: string): string {
  const fingerprint = value.trim().toLowerCase();
  if (!OCI_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new FinOpsBaseError(
      'El fingerprint OCI debe tener 16 pares hexadecimales separados por dos puntos.',
      'VALIDATION_ERROR',
    );
  }
  return fingerprint;
}

function formatOciFingerprint(hex: string): string {
  return hex.match(/.{2}/g)?.join(':') ?? hex;
}

function normalizePemLineBreaks(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
}
