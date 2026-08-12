import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { normalizeHistory } from './finOpsAiPrompts.js';
import type { AiChatInput, AiChatResponse } from './finOpsAiTypes.js';
import type { FinOpsContextAssembler } from './finOpsContextAssembler.js';
import { AiTraceRecorder } from './aiTraceRecorder.js';
import { looksLikeSpanish } from './aiLanguageGuard.js';
import { containsSensitiveOutput } from './evaluation/sensitiveOutputGuard.js';

/** Executes the chat use case while keeping chat-specific guards out of the facade. */
export class FinOpsAiChatRunner {
  constructor(
    private readonly analyticsRepository: ICostAnalyticsRepository,
    private readonly aiGateway: IAiGateway,
    private readonly contextAssembler: FinOpsContextAssembler,
    private readonly traceRecorder: AiTraceRecorder,
    private readonly model: string,
  ) {}

  public async run(input: AiChatInput): Promise<AiChatResponse> {
    const message = input.message.trim();
    if (message === '') {
      throw new FinOpsBaseError('Chat message is required', 'VALIDATION_ERROR');
    }

    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const { builtContext, systemPrompt } = await this.contextAssembler.assembleChatContext({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      message,
      snapshot,
    });
    const startedAt = Date.now();

    try {
      const answer = await this.aiGateway.generateText({
        responseFormat: 'text',
        temperature: 0.3,
        maxTokens: 900,
        messages: [
          { role: 'system', content: systemPrompt },
          ...normalizeHistory(input.history),
          { role: 'user', content: message },
        ],
      });

      if (!looksLikeSpanish(answer)) {
        throw new FinOpsBaseError(
          'El proveedor IA devolvió una respuesta que no cumple el idioma español requerido.',
          'AI_RESPONSE_ERROR',
        );
      }
      if (containsSensitiveOutput(answer)) {
        throw new FinOpsBaseError(
          'El proveedor IA devolvió un patrón que parece secreto o credencial utilizable.',
          'AI_RESPONSE_ERROR',
        );
      }

      await this.traceRecorder.record({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        operation: 'CHAT',
        model: this.model,
        ...(builtContext !== undefined ? { builtContext } : {}),
        startedAt,
        responseText: answer,
      });

      return { answer: answer.trim(), snapshot };
    } catch (error: unknown) {
      await this.traceRecorder.record({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        operation: 'CHAT',
        model: this.model,
        ...(builtContext !== undefined ? { builtContext } : {}),
        startedAt,
        error,
      });
      throw error;
    }
  }
}
