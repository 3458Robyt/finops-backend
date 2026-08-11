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
});

describe('safeErrorName', () => {
  it('keeps only the error class name', () => {
    const error = new TypeError('password=secret');
    expect(safeErrorName(error)).toBe('TypeError');
    expect(safeErrorName('failure')).toBe('UnknownError');
  });
});
