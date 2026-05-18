import { ConfigurationError, FinOpsBaseError } from '../../domain/errors/errors.js';

export interface TelegramSendMessageInput {
  readonly chatId: string;
  readonly text: string;
}

export interface ITelegramClient {
  sendMessage(input: TelegramSendMessageInput): Promise<void>;
}

export class TelegramClient implements ITelegramClient {
  constructor(
    private readonly botToken: string | undefined,
    private readonly enabled: boolean,
  ) {}

  public async sendMessage(input: TelegramSendMessageInput): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (this.botToken === undefined || this.botToken.trim() === '') {
      throw new ConfigurationError('TELEGRAM_BOT_TOKEN is required when Telegram is enabled');
    }

    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      throw new FinOpsBaseError(`Telegram sendMessage failed with status ${response.status}`, 'TELEGRAM_SEND_FAILED');
    }
  }
}
