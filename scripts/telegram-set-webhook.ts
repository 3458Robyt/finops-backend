import 'dotenv/config';

const urlArgIndex = process.argv.indexOf('--url');
const webhookUrl = urlArgIndex >= 0
  ? process.argv[urlArgIndex + 1]
  : process.argv.slice(2).find((arg) => arg.startsWith('https://'));
const botToken = process.env['TELEGRAM_BOT_TOKEN'];
const secretToken = process.env['TELEGRAM_WEBHOOK_SECRET'];

if (webhookUrl === undefined || webhookUrl.trim() === '') {
  console.error('Usage: npm run telegram:set-webhook -- --url https://<backend-public-url>/api/v1/telegram/webhook');
  process.exit(1);
}

if (botToken === undefined || botToken.trim() === '') {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

if (secretToken === undefined || secretToken.trim() === '') {
  console.error('TELEGRAM_WEBHOOK_SECRET is required');
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ['message'],
  }),
});

const body = await response.json() as unknown;

if (!response.ok) {
  console.error('Telegram setWebhook failed:', body);
  process.exit(1);
}

console.log('Telegram webhook configured:', body);
