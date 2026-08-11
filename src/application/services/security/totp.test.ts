import { describe, expect, test } from 'vitest';
import { verifyTotpCode } from './totp.js';

describe('TOTP', () => {
  test('matches the RFC 6238 SHA-1 vector at Unix time 59', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(verifyTotpCode(secret, '287082', 59_000)).toBe(1);
  });

  test('rejects malformed and incorrect codes', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(verifyTotpCode(secret, '12345', 59_000)).toBeNull();
    expect(verifyTotpCode(secret, '000000', 59_000)).toBeNull();
  });
});
