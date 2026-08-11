import { createHash, randomBytes } from 'node:crypto';

export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createOpaqueToken(ttlSeconds = DEFAULT_REFRESH_TOKEN_TTL_SECONDS): { readonly value: string; readonly expiresAt: Date } {
  return {
    value: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  };
}
