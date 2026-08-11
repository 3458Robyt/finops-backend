import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function verifyTotpCode(secret: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor(nowMs / 30_000);
  for (const offset of [-1, 0, 1]) {
    const step = currentStep + offset;
    if (step < 0) continue;
    const expected = totpAtStep(secret, step);
    const expectedBuffer = Buffer.from(expected, 'ascii');
    const codeBuffer = Buffer.from(code, 'ascii');
    if (expectedBuffer.length === codeBuffer.length && timingSafeEqual(expectedBuffer, codeBuffer)) {
      return step;
    }
  }
  return null;
}

export function buildTotpUri(secret: string, account: string, issuer = 'FinOps Inteligente'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function totpAtStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function encodeBase32(value: Buffer): string {
  let buffer = 0;
  let bits = 0;
  let result = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return result;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.replace(/=+$/g, '').toUpperCase();
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid TOTP secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}
