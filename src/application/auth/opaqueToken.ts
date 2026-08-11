import { createHash, randomBytes } from 'node:crypto';

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createOpaqueToken(): { readonly value: string; readonly expiresAt: Date } {
  return {
    value: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + readRefreshTtlSeconds() * 1000),
  };
}

function readRefreshTtlSeconds(): number {
  const raw = process.env['AUTH_REFRESH_TOKEN_TTL_SECONDS'];
  if (raw === undefined) return 30 * 24 * 60 * 60;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 300 && parsed <= 90 * 24 * 60 * 60
    ? parsed
    : 30 * 24 * 60 * 60;
}
