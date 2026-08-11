import { describe, expect, test } from 'vitest';
import {
  createMfaRecoveryCodeSet,
  hashMfaRecoveryCode,
  isMfaRecoveryCode,
  normalizeMfaRecoveryCode,
} from './mfaRecoveryCodes.js';

describe('MFA recovery codes', () => {
  test('generates ten unique one-time codes and stores only deterministic hashes', () => {
    const set = createMfaRecoveryCodeSet();

    expect(set.plainCodes).toHaveLength(10);
    expect(new Set(set.plainCodes).size).toBe(10);
    expect(set.codeHashes).toHaveLength(10);
    expect(set.plainCodes.every(isMfaRecoveryCode)).toBe(true);
    expect(set.codeHashes).toEqual(set.plainCodes.map(hashMfaRecoveryCode));
    expect(JSON.stringify(set.codeHashes)).not.toContain(set.plainCodes[0]);
  });

  test('normalizes separators and casing without accepting malformed values', () => {
    const code = 'abcde-12345-fabcd-67890';
    expect(normalizeMfaRecoveryCode(code)).toBe('ABCDE12345FABCD67890');
    expect(isMfaRecoveryCode(code)).toBe(true);
    expect(hashMfaRecoveryCode(code)).toBe(hashMfaRecoveryCode('ABCDE12345FABCD67890'));
    expect(isMfaRecoveryCode('not-a-recovery-code')).toBe(false);
  });
});
