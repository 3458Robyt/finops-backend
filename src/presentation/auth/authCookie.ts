import type { Response } from 'express';
import type { SameSitePolicy } from '../../infrastructure/config/runtimeConfigTypes.js';

export const REFRESH_COOKIE_NAME = 'finops_refresh';

export interface AuthCookieConfig {
  readonly secure: boolean;
  readonly sameSite: SameSitePolicy;
}

export function setRefreshCookie(res: Response, token: string, expiresAt: Date, config: AuthCookieConfig): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response, config: AuthCookieConfig): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    path: '/api/v1/auth',
  });
}

export function readRefreshCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== REFRESH_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (value === '') return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
