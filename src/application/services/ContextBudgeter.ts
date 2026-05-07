import type { AgentLearningContext } from '../../domain/interfaces/IAgentLearningService.js';

const defaultLearningSummaryLimit = 3500;

export class ContextBudgeter {
  constructor(private readonly maxLearningSummaryChars = defaultLearningSummaryLimit) {}

  public compactLearningContext(context: AgentLearningContext): AgentLearningContext {
    const lines = context.summary
      .split('\n')
      .map((line) => line.trim())
      .filter((line, index, all) => line !== '' && all.indexOf(line) === index);

    let summary = '';

    for (const line of lines) {
      const candidate = summary === '' ? line : `${summary}\n${line}`;

      if (candidate.length > this.maxLearningSummaryChars) {
        break;
      }

      summary = candidate;
    }

    return {
      memoryIds: context.memoryIds.slice(0, 10),
      caseIds: context.caseIds.slice(0, 10),
      summary,
    };
  }

  public truncate(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();

    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
  }
}
