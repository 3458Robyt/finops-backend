import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../infrastructure/config/runtimeConfigTypes.js';

const { createTransport, sendMail, verify, close } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: '<fixture-message-id>' }));
  const verify = vi.fn(async () => true);
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify, close }));
  return { createTransport, sendMail, verify, close };
});

vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { EmailClient } from './EmailClient.js';

const enabledConfig: RuntimeConfig['email'] = {
  enabled: true,
  timeoutMs: 12_345,
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  rateLimit: 20,
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'alerts@example.test',
  password: 'fixture-password',
  from: 'alerts@example.test',
  fromName: 'FinOps',
};

describe('EmailClient', () => {
  beforeEach(() => {
    createTransport.mockClear();
    sendMail.mockClear();
    verify.mockClear();
    close.mockClear();
  });

  it('applies the bounded timeout to every SMTP transport phase', async () => {
    const client = new EmailClient(enabledConfig);

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      connectionTimeout: 12_345,
      greetingTimeout: 12_345,
      socketTimeout: 12_345,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateLimit: 20,
    }));

    await expect(client.send({ to: 'user@example.test', subject: 'Test', text: 'Hello' }))
      .resolves.toEqual({ messageId: '<fixture-message-id>' });
  });

  it('verifies and closes the pooled transport without sending mail', async () => {
    const client = new EmailClient(enabledConfig);

    await expect(client.verify?.()).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledOnce();
    await client.close?.();
    expect(close).toHaveBeenCalledOnce();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does not create a transporter while the channel is disabled', () => {
    const client = new EmailClient({ ...enabledConfig, enabled: false });

    expect(client.enabled).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
  });
});
