import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramClient } from './TelegramClient.js';

describe('TelegramClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the request with an abort signal and succeeds for an OK response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new TelegramClient('fixture-token', true, 5_000);

    await expect(client.sendMessage({ chatId: '123', text: 'Mensaje de prueba' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/sendMessage'), expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('converts a provider timeout into a classified safe error', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new TelegramClient('fixture-token', true, 5);

    await expect(client.sendMessage({ chatId: '123', text: 'Mensaje de prueba' }))
      .rejects.toMatchObject({ code: 'TELEGRAM_TIMEOUT' });
  });

  it('surfaces Telegram rate limits with the provider retry hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 7 } }), { status: 429 })));
    const client = new TelegramClient('fixture-token', true, 5_000);

    await expect(client.sendMessage({ chatId: '123', text: 'Mensaje de prueba' }))
      .rejects.toMatchObject({ code: 'TELEGRAM_RATE_LIMITED', details: { retryAfterSeconds: 7 } });
  });

  it('verifies the bot identity without sending a message', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: 'finops_bot' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new TelegramClient('fixture-token', true, 5_000);

    await expect(client.verify?.()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/getMe'), expect.objectContaining({ method: 'POST' }));
  });
});
