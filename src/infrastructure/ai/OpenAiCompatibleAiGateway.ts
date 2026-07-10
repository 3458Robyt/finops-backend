import OpenAI from 'openai';

import { ConfigurationError } from '../../domain/errors/errors.js';
import type { AiGatewayRequest, IAiGateway } from '../../domain/interfaces/IAiGateway.js';

/**
 * Adaptador de infraestructura para endpoints compatibles con la API de OpenAI.
 *
 * Variables principales:
 * - AI_API_KEY
 * - AI_BASE_URL
 * - AI_MODEL
 * - AI_TIMEOUT_MS
 * - AI_MAX_RETRIES
 *
 * Las variables NVIDIA_* / NIM_API_KEY siguen funcionando como fallback temporal.
 */
export class OpenAiCompatibleAiGateway implements IAiGateway {
  private readonly client: OpenAI;
  private readonly model: string;

  public readonly modelName: string;

  public constructor() {
    const apiKey =
      process.env['AI_API_KEY'] ?? process.env['NVIDIA_API_KEY'] ?? process.env['NIM_API_KEY'];

    if (apiKey === undefined || apiKey.trim() === '') {
      throw new ConfigurationError('AI_API_KEY must be configured before using AI features');
    }

    this.model = process.env['AI_MODEL'] ?? process.env['NVIDIA_MODEL'] ?? 'gpt-5.4-mini';
    this.modelName = this.model;
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env['AI_BASE_URL'] ?? process.env['NVIDIA_BASE_URL'] ?? 'https://api.openai.com/v1',
      timeout: readPositiveIntegerEnv('AI_TIMEOUT_MS', process.env['NVIDIA_TIMEOUT_MS'], 60000),
      maxRetries: readNonNegativeIntegerEnv('AI_MAX_RETRIES', 1),
    });
  }

  public async generateText(request: AiGatewayRequest): Promise<string> {
    const completion = await this.client.chat.completions.create(
      {
        model: request.model ?? this.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        temperature: request.temperature ?? 0.3,
        top_p: 0.95,
        max_tokens: request.maxTokens ?? 2048,
        stream: true,
        chat_template_kwargs: { thinking: false },
      } as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
      {
        ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
        ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
      },
    );

    let output = '';
    const stream = completion as AsyncIterable<{
      readonly choices?: ReadonlyArray<{
        readonly delta?: {
          readonly content?: string | null;
        };
      }>;
    }>;

    for await (const chunk of stream) {
      output += chunk.choices?.[0]?.delta?.content ?? '';
    }

    return output;
  }
}

function readPositiveIntegerEnv(primaryKey: string, fallbackRaw: string | undefined, defaultValue: number): number {
  const raw = process.env[primaryKey] ?? fallbackRaw;
  if (raw === undefined) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function readNonNegativeIntegerEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}
