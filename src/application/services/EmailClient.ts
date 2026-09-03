import nodemailer from 'nodemailer';
import { ConfigurationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { loadRuntimeConfig } from '../../infrastructure/config/runtimeConfigReader.js';
import type { RuntimeConfig } from '../../infrastructure/config/runtimeConfigTypes.js';

export interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface IEmailClient {
  readonly enabled: boolean;
  send(input: EmailSendInput): Promise<{ readonly messageId?: string }>;
  verify?(): Promise<void>;
  close?(): Promise<void>;
}

export class EmailClient implements IEmailClient {
  public readonly enabled: boolean;

  private readonly from: string | undefined;
  private readonly transporter: nodemailer.Transporter | undefined;

  constructor(config: RuntimeConfig['email'] = loadRuntimeConfig().email) {
    this.enabled = config.enabled;

    if (!this.enabled) {
      this.from = undefined;
      this.transporter = undefined;
      return;
    }

    const host = config.host;
    const user = config.user;
    const pass = config.password;
    const fromEmail = config.from ?? user;

    if (host === undefined || user === undefined || pass === undefined || fromEmail === undefined) {
      throw new ConfigurationError('SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM are required when EMAIL_ENABLED=true');
    }

    const port = config.port;
    const secure = config.secure;
    const fromName = config.fromName;

    this.from = `${fromName} <${fromEmail}>`;
    const transportOptions = {
      host,
      port,
      secure,
      pool: config.pool,
      maxConnections: config.maxConnections,
      maxMessages: config.maxMessages,
      rateLimit: config.rateLimit,
      connectionTimeout: config.timeoutMs,
      greetingTimeout: config.timeoutMs,
      socketTimeout: config.timeoutMs,
      auth: { user, pass },
    } as unknown as Parameters<typeof nodemailer.createTransport>[0];

    this.transporter = nodemailer.createTransport(transportOptions);
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

  /** Valida DNS/TCP/TLS/autenticación sin emitir correo. */
  public async verify(): Promise<void> {
    if (!this.enabled) throw new FinOpsBaseError('Email channel is disabled', 'EMAIL_DISABLED');
    if (this.transporter === undefined) throw new ConfigurationError('Email client is not configured');
    await this.transporter.verify();
  }

  /** Libera las conexiones SMTP persistentes durante el cierre ordenado. */
  public async close(): Promise<void> {
    this.transporter?.close();
  }
}
