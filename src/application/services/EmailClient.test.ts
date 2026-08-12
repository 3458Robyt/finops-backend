import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../infrastructure/config/runtimeConfigTypes.js';

const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: '<fixture-message-id>' }));
  const createTransport = vi.fn(() => ({ sendMail }));
  return { createTransport, sendMail };
});

vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { EmailClient } from './EmailClient.js';

const enabledConfig: RuntimeConfig['email'] = {
  enabled: true,
  timeoutMs: 12_345,
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
  });

  it('applies the bounded timeout to every SMTP transport phase', async () => {
    const client = new EmailClient(enabledConfig);

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      connectionTimeout: 12_345,
      greetingTimeout: 12_345,
      socketTimeout: 12_345,
    }));

    await expect(client.send({ to: 'user@example.test', subject: 'Test', text: 'Hello' }))
      .resolves.toEqual({ messageId: '<fixture-message-id>' });
  });

  it('does not create a transporter while the channel is disabled', () => {
    const client = new EmailClient({ ...enabledConfig, enabled: false });

    expect(client.enabled).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
  });
});
