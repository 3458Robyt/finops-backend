import { describe, expect, it } from 'vitest';
import { safeErrorMessage, safeErrorName } from './safeError.js';

describe('safeErrorMessage', () => {
  it('redacts credentials, API keys, JWTs and PEM material', () => {
    const message = 'postgresql://user:password@db.example.test:5432/app apiKey=sk-12345678901234567890 eyJheader.payload.signature -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----';

    const sanitized = safeErrorMessage(new Error(message));

    expect(sanitized).not.toContain('password@');
    expect(sanitized).not.toContain('sk-12345678901234567890');
    expect(sanitized).not.toContain('eyJheader.payload.signature');
    expect(sanitized).not.toContain('PRIVATE KEY-----secret');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('bounds unexpected values and provides a fallback', () => {
    expect(safeErrorMessage('   ', 10)).toBe('Unknown er');
    expect(safeErrorMessage('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij');
  });

  it('extracts useful details from structured provider errors', () => {
    const sanitized = safeErrorMessage({
      statusCode: 403,
      serviceCode: 'NotAuthorizedOrNotFound',
      message: 'The caller is not authorized to perform this operation.',
      apiKey: 'do-not-log',
    });

    expect(sanitized).toContain('NotAuthorizedOrNotFound');
    expect(sanitized).toContain('not authorized');
    expect(sanitized).not.toContain('do-not-log');
  });

  it('redacts bearer and cookie header material', () => {
    const sanitized = safeErrorMessage(
      'Authorization: Bearer abcdefghijklmnop Cookie: session=super-secret; refresh=other-secret',
    );

    expect(sanitized).toBe('Authorization: [REDACTED] Cookie: [REDACTED]');
    expect(sanitized).not.toContain('super-secret');
    expect(sanitized).not.toContain('other-secret');
  });
});

describe('safeErrorName', () => {
  it('keeps only the error class name', () => {
    const error = new TypeError('password=secret');
    expect(safeErrorName(error)).toBe('TypeError');
    expect(safeErrorName('failure')).toBe('UnknownError');
  });
});
