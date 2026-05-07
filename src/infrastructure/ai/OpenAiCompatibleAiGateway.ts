import OpenAI from 'openai';
import { ConfigurationError } from '../../domain/errors/errors.js';
import type { AiGatewayRequest, IAiGateway } from '../../domain/interfaces/IAiGateway.js';

export class OpenAiCompatibleAiGateway implements IAiGateway {
  private readonly client: OpenAI;
  private readonly model: string;
  public readonly modelName: string;

  constructor() {
    const apiKey = process.env['NVIDIA_API_KEY'] ?? process.env['NIM_API_KEY'];

    if (apiKey === undefined || apiKey.trim() === '') {
      throw new ConfigurationError('NVIDIA_API_KEY must be configured before using AI features');
    }

    this.model = process.env['NVIDIA_MODEL'] ?? 'deepseek-ai/deepseek-v4-flash';
    this.modelName = this.model;
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env['NVIDIA_BASE_URL'] ?? 'https://integrate.api.nvidia.com/v1',
      timeout: this.readTimeoutMs(),
    });
  }

  public async generateText(request: AiGatewayRequest): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: request.model ?? this.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: request.temperature ?? 0.3,
      top_p: 0.95,
      max_tokens: request.maxTokens ?? 2048,
      stream: true,
      chat_template_kwargs: {
        thinking: false,
      },
    } as unknown as Parameters<OpenAI['chat']['completions']['create']>[0], {
      ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
      ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
    });

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

  private readTimeoutMs(): number {
    const raw = process.env['NVIDIA_TIMEOUT_MS'];

    if (raw === undefined) {
      return 60000;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
  }
}
