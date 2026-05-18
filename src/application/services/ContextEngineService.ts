import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type {
  BuildAiContextInput,
  BuiltAiContext,
  IContextEngineService,
} from '../../domain/interfaces/IContextEngineService.js';
import type { IAgentLearningContextProvider } from '../../domain/interfaces/IAgentLearningService.js';
import type { AiContextOperation, TenantAgentRule } from '../../domain/models/AgentContext.js';
import { AgentInstructionService } from './AgentInstructionService.js';
import { ContextBudgeter } from './ContextBudgeter.js';

const budgets: Record<AiContextOperation, number> = {
  CHAT: 3000,
  RECOMMENDATION: 7000,
  EXECUTION_PLAN: 8000,
  AUDIT: 5000,
  LEARNING: 3500,
};

export class ContextEngineService implements IContextEngineService {
  constructor(
    private readonly repository: IAgentContextRepository,
    private readonly instructionService: AgentInstructionService,
    private readonly learningContextProvider?: IAgentLearningContextProvider,
    private readonly budgeter = new ContextBudgeter(),
  ) {}

  public async buildContext(input: BuildAiContextInput): Promise<BuiltAiContext> {
    const [profile, tenantRules, summaries, learningContext] = await Promise.all([
      this.instructionService.getActiveProfile(),
      this.repository.listTenantRules(input.tenantId),
      this.repository.findContextSummaries({
        tenantId: input.tenantId,
        queryText: input.queryText,
        limit: 8,
      }),
      this.learningContextProvider?.getRecommendationLearningContext({
        tenantId: input.tenantId,
        queryText: input.queryText,
        limit: 5,
      }) ?? Promise.resolve({
        memoryIds: [],
        caseIds: [],
        summary: '',
      }),
    ]);
    const { acceptedRules, conflicts } = this.instructionService.filterRulesAgainstProfile({
      tenantId: input.tenantId,
      profile,
      rules: tenantRules,
    });
    const budget = budgets[input.operation];
    const rawContext = [
      this.formatProfile(profile.structuredRules, profile.freeformNotes),
      this.formatTenantRules(acceptedRules),
      this.formatSummaries(summaries),
      this.formatLearning(learningContext.summary),
      this.formatSnapshot(input.snapshot),
      input.recommendation !== undefined
        ? `Recomendacion objetivo:\n${JSON.stringify(input.recommendation, null, 2)}`
        : '',
    ].filter((section) => section.trim() !== '').join('\n\n');
    const contextText = this.budgeter.truncate(rawContext, budget);
    const systemInstructions = [
      'Instrucciones TAK activas para el agente principal:',
      `Perfil TAK version ${profile.version}.`,
      'Responder y generar artefactos siempre en espanol.',
      'Usar el contexto como evidencia, no como permiso para inventar datos.',
      'No inferir CPU, memoria, IOPS, throughput ni utilizacion tecnica desde FOCUS.',
      'No prometer ejecucion automatica de cambios cloud.',
    ].join('\n');

    return {
      systemInstructions,
      contextText,
      artifactIds: summaries.map((summary) => summary.id),
      memoryIds: learningContext.memoryIds,
      caseIds: learningContext.caseIds,
      knowledgeNodeIds: [],
      tenantRuleIds: acceptedRules.map((rule) => rule.id),
      conflicts,
      profileVersion: profile.version,
      promptTokenEstimate: this.estimateTokens(`${systemInstructions}\n${contextText}`),
    };
  }

  private formatProfile(
    rules: Awaited<ReturnType<AgentInstructionService['getActiveProfile']>>['structuredRules'],
    freeformNotes: string | undefined,
  ): string {
    return [
      'Perfil global TAK:',
      `Objetivo: ${rules.objective}`,
      `Tono: ${rules.tone}`,
      `Prioridades: ${rules.recommendationPriorities.join('; ')}`,
      `Requisitos de evidencia: ${rules.evidenceRequirements.join('; ')}`,
      `Politica de riesgo: ${rules.riskPolicy}`,
      `Acciones prohibidas: ${rules.forbiddenActions.join('; ')}`,
      freeformNotes !== undefined ? `Notas administradas: ${freeformNotes}` : '',
    ].filter((line) => line !== '').join('\n');
  }

  private formatTenantRules(rules: readonly TenantAgentRule[]): string {
    if (rules.length === 0) {
      return 'Reglas tenant activas: ninguna.';
    }

    return [
      'Reglas tenant activas no conflictivas:',
      ...rules.map((rule) => `- [${rule.category}] ${rule.ruleText}`),
    ].join('\n');
  }

  private formatSummaries(summaries: readonly { readonly artifactType: string; readonly scopeKey: string; readonly summary: string }[]): string {
    if (summaries.length === 0) {
      return 'Resumenes cacheados relevantes: no hay resumenes cacheados todavia.';
    }

    return [
      'Resumenes cacheados relevantes:',
      ...summaries.map((summary) => `- ${summary.artifactType}/${summary.scopeKey}: ${summary.summary}`),
    ].join('\n');
  }

  private formatLearning(summary: string): string {
    return summary.trim() === ''
      ? 'Memoria auditada relevante: no hay patrones previos relevantes.'
      : `Memoria auditada relevante:\n${summary}`;
  }

  private formatSnapshot(snapshot: unknown): string {
    return `Snapshot factual autorizado:\n${JSON.stringify(snapshot, null, 2)}`;
  }

  private estimateTokens(value: string): number {
    return Math.ceil(value.length / 4);
  }
}
