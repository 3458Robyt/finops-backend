import { createHash, randomBytes, randomUUID } from 'node:crypto';

const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_COUNT = 10;
const NORMALIZED_RECOVERY_CODE = /^[A-F0-9]{20}$/;

export interface MfaRecoveryCodeSet {
  readonly batchId: string;
  readonly plainCodes: readonly string[];
  readonly codeHashes: readonly string[];
}

export function createMfaRecoveryCodeSet(): MfaRecoveryCodeSet {
  const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => formatRecoveryCode(
    randomBytes(RECOVERY_CODE_BYTES).toString('hex').toUpperCase(),
  ));
  return {
    batchId: randomUUID(),
    plainCodes,
    codeHashes: plainCodes.map(hashMfaRecoveryCode),
  };
}

export function isMfaRecoveryCode(value: string): boolean {
  return NORMALIZED_RECOVERY_CODE.test(normalizeMfaRecoveryCode(value));
}

export function hashMfaRecoveryCode(value: string): string {
  const normalized = normalizeMfaRecoveryCode(value);
  return createHash('sha256').update(`finops:mfa-recovery:${normalized}`, 'utf8').digest('hex');
}

export function normalizeMfaRecoveryCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-F0-9]/g, '');
}

function formatRecoveryCode(value: string): string {
  return value.match(/.{1,5}/g)?.join('-') ?? value;
}
