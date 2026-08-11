import type { Response } from 'express';

export const REFRESH_COOKIE_NAME = 'finops_refresh';

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: readSameSitePolicy(),
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: readSameSitePolicy(),
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

function readSameSitePolicy(): 'strict' | 'lax' | 'none' {
  const value = process.env['AUTH_COOKIE_SAME_SITE']?.trim().toLowerCase();
  return value === 'strict' || value === 'none' ? value : 'lax';
}
