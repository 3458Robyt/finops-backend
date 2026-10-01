import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import type { AuthService } from '../../application/services/AuthService.js';
import { AuthSessionController } from './AuthSessionController.js';

describe('AuthSessionController.refresh', () => {
  it('returns no-content and clears the cookie when no session exists', async () => {
    const controller = new AuthSessionController(
      {} as AuthService,
      { secure: false, sameSite: 'lax' },
      3600,
    );
    const response = createResponse();

    await controller.refresh(
      { header: () => undefined } as unknown as Request,
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(204);
    expect(response.ended).toBe(true);
    expect(response.clearedCookie).toBe('finops_refresh');
  });
});

function createResponse(): {
  statusCode: number;
  ended: boolean;
  clearedCookie: string | undefined;
  clearCookie: (name: string) => void;
  status: (code: number) => { end: () => void };
} {
  return {
    statusCode: 200,
    ended: false,
    clearedCookie: undefined,
    clearCookie(name: string) { this.clearedCookie = name; },
    status(code: number) {
      this.statusCode = code;
      return { end: () => { this.ended = true; } };
    },
  };
}
