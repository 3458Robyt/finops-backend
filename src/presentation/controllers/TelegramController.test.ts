import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import type { TelegramBotService } from '../../application/services/TelegramBotService.js';
import type { TelegramLinkService } from '../../application/services/TelegramLinkService.js';
import { TelegramController } from './TelegramController.js';

describe('TelegramController', () => {
  it('rejects webhook calls with an invalid Telegram secret', async () => {
    const controller = new TelegramController(
      { handleUpdate: async () => undefined } as unknown as TelegramBotService,
      {} as TelegramLinkService,
      'expected-secret',
      true,
    );
    const response = createResponse();

    await controller.webhook(
      {
        header: (name: string) => (name === 'X-Telegram-Bot-Api-Secret-Token' ? 'wrong-secret' : undefined),
        body: {},
      } as unknown as Request,
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({ success: false, code: 'AUTHENTICATION_FAILED' });
  });

  it('accepts webhook calls with the configured secret', async () => {
    let handled = false;
    const controller = new TelegramController(
      { handleUpdate: async () => { handled = true; } } as unknown as TelegramBotService,
      {} as TelegramLinkService,
      'expected-secret',
      true,
    );
    const response = createResponse();

    await controller.webhook(
      {
        header: (name: string) => (name === 'X-Telegram-Bot-Api-Secret-Token' ? 'expected-secret' : undefined),
        body: { update_id: 1 },
      } as unknown as Request,
      response as unknown as Response,
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true });
  });
});

function createResponse(): {
  statusCode: number;
  body: unknown;
  status: (statusCode: number) => { json: (body: unknown) => void };
} {
  return {
    statusCode: 200,
    body: undefined,
    status(statusCode: number) {
      this.statusCode = statusCode;
      return {
        json: (body: unknown) => {
          this.body = body;
        },
      };
    },
  };
}
