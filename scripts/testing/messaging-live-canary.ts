import 'dotenv/config';

import { safeErrorMessage } from '../../src/application/observability/safeError.js';
import { EmailClient } from '../../src/application/services/EmailClient.js';
import { TelegramClient } from '../../src/application/services/TelegramClient.js';
import { loadRuntimeConfig } from '../../src/infrastructure/config/runtimeConfigReader.js';

const confirmation = process.env['MESSAGING_CANARY_CONFIRM'];
const requiredConfirmation = 'I_UNDERSTAND_THIS_SENDS_A_REAL_MESSAGE';

if (confirmation !== requiredConfirmation) {
  console.log(JSON.stringify({
    status: 'SKIPPED',
    reason: `Define MESSAGING_CANARY_CONFIRM=${requiredConfirmation} para enviar un mensaje real.`,
  }));
  process.exit(0);
}

const emailTarget = optionalEnv('MESSAGING_CANARY_EMAIL_TO');
const telegramTarget = optionalEnv('MESSAGING_CANARY_TELEGRAM_CHAT_ID');
if (emailTarget === undefined && telegramTarget === undefined) {
  throw new Error('Define MESSAGING_CANARY_EMAIL_TO o MESSAGING_CANARY_TELEGRAM_CHAT_ID.');
}

const config = loadRuntimeConfig();
const emailClient = new EmailClient(config.email);
const telegramClient = new TelegramClient(config.telegram.botToken, config.telegram.enabled, config.telegram.timeoutMs);
const text = [
  'Canary controlado de FinOps Inteligente.',
  `Fecha: ${new Date().toISOString()}.`,
  'Este mensaje confirma conectividad del proveedor; no contiene datos FinOps ni modifica la base de datos.',
].join('\n');
const results: Array<{ readonly channel: 'EMAIL' | 'TELEGRAM'; readonly status: 'SENT' | 'FAILED'; readonly error?: string }> = [];

if (emailTarget !== undefined) {
  results.push(await sendEmail(emailClient, emailTarget, text));
}
if (telegramTarget !== undefined) {
  results.push(await sendTelegram(telegramClient, telegramTarget, text));
}

console.log(JSON.stringify({ status: results.every((result) => result.status === 'SENT') ? 'PASSED' : 'FAILED', results }, null, 2));
if (results.some((result) => result.status === 'FAILED')) process.exitCode = 1;

async function sendEmail(client: EmailClient, to: string, text: string): Promise<{ readonly channel: 'EMAIL'; readonly status: 'SENT' | 'FAILED'; readonly error?: string }> {
  try {
    await client.send({ to, subject: 'Canary FinOps Inteligente', text });
    return { channel: 'EMAIL', status: 'SENT' };
  } catch (error: unknown) {
    return { channel: 'EMAIL', status: 'FAILED', error: safeErrorMessage(error) };
  }
}

async function sendTelegram(client: TelegramClient, chatId: string, text: string): Promise<{ readonly channel: 'TELEGRAM'; readonly status: 'SENT' | 'FAILED'; readonly error?: string }> {
  try {
    await client.sendMessage({ chatId, text });
    return { channel: 'TELEGRAM', status: 'SENT' };
  } catch (error: unknown) {
    return { channel: 'TELEGRAM', status: 'FAILED', error: safeErrorMessage(error) };
  }
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
