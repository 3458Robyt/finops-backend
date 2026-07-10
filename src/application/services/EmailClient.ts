import nodemailer from 'nodemailer';
import { ConfigurationError, FinOpsBaseError } from '../../domain/errors/errors.js';

export interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface IEmailClient {
  readonly enabled: boolean;
  send(input: EmailSendInput): Promise<{ readonly messageId?: string }>;
}

export class EmailClient implements IEmailClient {
  public readonly enabled: boolean;

  private readonly from: string | undefined;
  private readonly transporter: nodemailer.Transporter | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.enabled = env['EMAIL_ENABLED'] === 'true';

    if (!this.enabled) {
      this.from = undefined;
      this.transporter = undefined;
      return;
    }

    const host = env['SMTP_HOST'];
    const user = env['SMTP_USER'];
    const pass = env['SMTP_PASSWORD'];
    const fromEmail = env['SMTP_FROM'] ?? user;

    if (host === undefined || user === undefined || pass === undefined || fromEmail === undefined) {
      throw new ConfigurationError('SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM are required when EMAIL_ENABLED=true');
    }

    const port = Number.parseInt(env['SMTP_PORT'] ?? '587', 10);
    const secure = env['SMTP_SECURE'] === 'true';
    const fromName = env['SMTP_FROM_NAME'] ?? 'FinOps Inteligente';

    this.from = `${fromName} <${fromEmail}>`;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
  }

  public async send(input: EmailSendInput): Promise<{ readonly messageId?: string }> {
    if (!this.enabled) {
      throw new FinOpsBaseError('Email channel is disabled', 'EMAIL_DISABLED');
    }
    if (this.transporter === undefined || this.from === undefined) {
      throw new ConfigurationError('Email client is not configured');
    }

    const result = await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });

    return {
      ...(typeof result.messageId === 'string' ? { messageId: result.messageId } : {}),
    };
  }
}
