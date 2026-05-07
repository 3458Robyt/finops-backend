export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiGatewayMessage {
  readonly role: AiMessageRole;
  readonly content: string;
}

export interface AiGatewayRequest {
  readonly messages: readonly AiGatewayMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly responseFormat?: 'text' | 'json';
  readonly model?: string;
}

export interface IAiGateway {
  readonly modelName?: string;
  generateText(request: AiGatewayRequest): Promise<string>;
}
