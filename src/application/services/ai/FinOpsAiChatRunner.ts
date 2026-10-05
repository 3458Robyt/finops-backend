import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/costAnalytics/costAnalyticsModels.js';
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
    private readonly requestPolicy: { readonly timeoutMs: number; readonly maxRetries: number } = { timeoutMs: 60_000, maxRetries: 1 },
  ) {}

  public async run(input: AiChatInput): Promise<AiChatResponse> {
    const message = input.message.trim();
    const outputFormat = input.outputFormat ?? 'MARKDOWN';
    if (message === '') {
      throw new FinOpsBaseError('Chat message is required', 'VALIDATION_ERROR');
    }

    const snapshot = await selectChatSnapshot(this.analyticsRepository, input.tenantId, message);
    const { builtContext, systemPrompt } = await this.contextAssembler.assembleChatContext({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      message,
      snapshot,
      outputFormat,
    });
    const startedAt = Date.now();

    try {
      const answer = await this.aiGateway.generateText({
        responseFormat: 'text',
        timeoutMs: this.requestPolicy.timeoutMs,
        maxRetries: this.requestPolicy.maxRetries,
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
        ...(input.traceSource !== undefined ? { source: input.traceSource } : {}),
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
        ...(input.traceSource !== undefined ? { source: input.traceSource } : {}),
        model: this.model,
        ...(builtContext !== undefined ? { builtContext } : {}),
        startedAt,
        error,
      });
      throw error;
    }
  }
}

async function selectChatSnapshot(
  repository: ICostAnalyticsRepository,
  tenantId: string,
  message: string,
): Promise<NonNullable<Awaited<ReturnType<ICostAnalyticsRepository['getLatestTenantSnapshot']>>>> {
  const requestedMonth = requestedCalendarMonth(message);
  if (requestedMonth !== undefined && repository.getTenantSnapshotForPeriod !== undefined) {
    let latest: CostAnalyticsSnapshot | undefined;
    let observedThrough = repository.getLatestObservedThrough === undefined
      ? undefined
      : await repository.getLatestObservedThrough(tenantId);
    if (observedThrough !== undefined && Number.isNaN(observedThrough.getTime())) {
      observedThrough = undefined;
    }
    if (observedThrough === undefined) {
      latest = await repository.getLatestTenantSnapshot(tenantId);
      const snapshotObservedThrough = latest.observedThrough === undefined
        ? undefined
        : new Date(latest.observedThrough);
      if (snapshotObservedThrough !== undefined && !Number.isNaN(snapshotObservedThrough.getTime())) {
        observedThrough = snapshotObservedThrough;
      }
    }

    const latestPeriodStart = latest === undefined ? undefined : new Date(latest.periodStart);
    const referenceDate = observedThrough
      ?? (latestPeriodStart !== undefined && !Number.isNaN(latestPeriodStart.getTime()) ? latestPeriodStart : new Date());
    let year = requestedMonth.year ?? referenceDate.getUTCFullYear();
    if (requestedMonth.year === undefined && requestedMonth.month > referenceDate.getUTCMonth()) year -= 1;

    const periodStart = new Date(Date.UTC(year, requestedMonth.month, 1));
    const monthEnd = new Date(Date.UTC(year, requestedMonth.month + 1, 1));
    const periodEnd = observedThrough !== undefined
      && observedThrough > periodStart
      && observedThrough < monthEnd
      ? observedThrough
      : monthEnd;
    return repository.getTenantSnapshotForPeriod(tenantId, periodStart, periodEnd);
  }

  const requestedDays = requestedRelativeDays(message);
  if (requestedDays === undefined || repository.getTenantSnapshotForPeriod === undefined) {
    return repository.getLatestTenantSnapshot(tenantId);
  }

  const latestObservedThrough = repository.getLatestObservedThrough === undefined
    ? undefined
    : await repository.getLatestObservedThrough(tenantId);
  let latest: CostAnalyticsSnapshot | undefined;
  let observedThrough = latestObservedThrough;
  if (observedThrough === undefined) {
    latest = await repository.getLatestTenantSnapshot(tenantId);
    observedThrough = latest.observedThrough === undefined ? undefined : new Date(latest.observedThrough);
  }
  if (observedThrough === undefined || Number.isNaN(observedThrough.getTime())) {
    return latest ?? repository.getLatestTenantSnapshot(tenantId);
  }

  const periodEnd = new Date(Math.min(observedThrough.getTime(), Date.now()));
  const periodStart = new Date(periodEnd.getTime() - requestedDays * 24 * 60 * 60 * 1000);
  if (periodStart >= periodEnd) return latest ?? repository.getLatestTenantSnapshot(tenantId);

  return repository.getTenantSnapshotForPeriod(tenantId, periodStart, periodEnd);
}

interface RequestedCalendarMonth {
  readonly month: number;
  readonly year?: number;
}

const CALENDAR_MONTHS: readonly { readonly month: number; readonly aliases: readonly string[] }[] = [
  { month: 0, aliases: ['enero', 'ene'] },
  { month: 1, aliases: ['febrero', 'feb'] },
  { month: 2, aliases: ['marzo', 'mar'] },
  { month: 3, aliases: ['abril', 'abr'] },
  { month: 4, aliases: ['mayo', 'may'] },
  { month: 5, aliases: ['junio', 'jun'] },
  { month: 6, aliases: ['julio', 'jul'] },
  { month: 7, aliases: ['agosto', 'ago'] },
  { month: 8, aliases: ['septiembre', 'setiembre', 'sept', 'sep'] },
  { month: 9, aliases: ['octubre', 'oct'] },
  { month: 10, aliases: ['noviembre', 'nov'] },
  { month: 11, aliases: ['diciembre', 'dic'] },
];

function requestedCalendarMonth(message: string): RequestedCalendarMonth | undefined {
  const normalized = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  for (const entry of CALENDAR_MONTHS) {
    const aliases = [...entry.aliases].sort((left, right) => right.length - left.length);
    const match = new RegExp(`\\b(?:${aliases.join('|')})\\b`).exec(normalized);
    if (match === null) continue;

    const afterMonth = normalized.slice(match.index + match[0].length);
    const yearAfter = /^\s+(?:(?:de|del)\s+)?((?:19|20|21)\d{2})\b/.exec(afterMonth);
    const beforeMonth = normalized.slice(0, match.index);
    const yearBefore = /\b((?:19|20|21)\d{2})\s+(?:(?:de|del)\s+)?$/.exec(beforeMonth);
    const yearValue = yearAfter?.[1] ?? yearBefore?.[1];
    const year = yearValue === undefined ? undefined : Number(yearValue);
    return {
      month: entry.month,
      ...(year !== undefined && Number.isInteger(year) ? { year } : {}),
    };
  }
  return undefined;
}

function requestedRelativeDays(message: string): number | undefined {
  const normalized = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const match = normalized.match(/\bultim(?:o|a|os|as)\s+(\d{1,4})\s+dias?\b/);
  if (match === null) return undefined;
  const days = Number(match[1]);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : undefined;
}
