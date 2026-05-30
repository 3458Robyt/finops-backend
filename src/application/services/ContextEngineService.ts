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

/**
 * Presupuesto de caracteres (proxy de tokens) asignado a cada tipo de operación
 * de IA. Operaciones más complejas (planes de ejecución, recomendaciones)
 * disponen de un presupuesto mayor que las conversacionales (CHAT).
 */
const budgets: Record<AiContextOperation, number> = {
  CHAT: 3000,
  RECOMMENDATION: 7000,
  EXECUTION_PLAN: 8000,
  AUDIT: 5000,
  LEARNING: 3500,
};

/**
 * Servicio de aplicación central del Context Engine. Su responsabilidad es
 * ensamblar el contexto que se inyecta al agente principal de IA combinando
 * múltiples fuentes de evidencia: el perfil global TAK, las reglas del tenant,
 * los resúmenes cacheados, la memoria de aprendizaje auditada y el snapshot
 * factual de la operación. El contexto resultante se acota al presupuesto del
 * tipo de operación.
 *
 * Colaboradores inyectados:
 * - {@link IAgentContextRepository}: acceso a reglas de tenant y resúmenes de contexto.
 * - {@link AgentInstructionService}: obtiene el perfil TAK activo y filtra reglas conflictivas.
 * - {@link IAgentLearningContextProvider} (opcional): aporta memoria de aprendizaje relevante.
 * - {@link ContextBudgeter}: aplica el presupuesto de tokens/caracteres al contexto.
 *
 * Rol dentro del flujo: es el orquestador que produce las instrucciones de
 * sistema y el texto de contexto consumidos por los servicios de IA (chat,
 * recomendaciones, planes, auditoría).
 */
export class ContextEngineService implements IContextEngineService {
  constructor(
    private readonly repository: IAgentContextRepository,
    private readonly instructionService: AgentInstructionService,
    private readonly learningContextProvider?: IAgentLearningContextProvider,
    private readonly budgeter = new ContextBudgeter(),
  ) {}

  /**
   * Construye el contexto completo para una operación de IA de un tenant.
   *
   * Recupera en paralelo el perfil TAK activo, las reglas del tenant, los
   * resúmenes de contexto relevantes a la consulta y la memoria de aprendizaje.
   * Filtra las reglas de tenant que entran en conflicto con el perfil global,
   * formatea cada sección de evidencia, las concatena y trunca el resultado al
   * presupuesto correspondiente al tipo de operación. Finalmente compone las
   * instrucciones de sistema (idioma, uso de evidencia, restricciones FOCUS).
   *
   * Efecto secundario: realiza lecturas a través del repositorio y del proveedor
   * de contexto de aprendizaje (no escribe datos).
   *
   * @param input - Parámetros de construcción: tenant, operación, texto de consulta,
   *   snapshot factual y, opcionalmente, una recomendación objetivo.
   * @returns El contexto ensamblado: instrucciones de sistema, texto de contexto
   *   truncado, identificadores de evidencia, conflictos detectados, versión del
   *   perfil y la estimación de tokens del prompt.
   */
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

  /**
   * Formatea el perfil global TAK como bloque de texto legible para el modelo,
   * incluyendo objetivo, tono, prioridades, requisitos de evidencia, política
   * de riesgo y acciones prohibidas. Las notas administradas solo se incluyen
   * cuando están definidas.
   */
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

  /**
   * Formatea las reglas de tenant aceptadas (no conflictivas) como lista. Si no
   * hay reglas activas se devuelve un texto explícito para que el modelo sepa
   * que no existen, en lugar de omitir la sección.
   */
  private formatTenantRules(rules: readonly TenantAgentRule[]): string {
    if (rules.length === 0) {
      return 'Reglas tenant activas: ninguna.';
    }

    return [
      'Reglas tenant activas no conflictivas:',
      ...rules.map((rule) => `- [${rule.category}] ${rule.ruleText}`),
    ].join('\n');
  }

  /**
   * Formatea los resúmenes cacheados relevantes recuperados para la consulta.
   * Devuelve un texto explícito cuando no hay resúmenes para no inducir al
   * modelo a inventar evidencia inexistente.
   */
  private formatSummaries(summaries: readonly { readonly artifactType: string; readonly scopeKey: string; readonly summary: string }[]): string {
    if (summaries.length === 0) {
      return 'Resumenes cacheados relevantes: no hay resumenes cacheados todavia.';
    }

    return [
      'Resumenes cacheados relevantes:',
      ...summaries.map((summary) => `- ${summary.artifactType}/${summary.scopeKey}: ${summary.summary}`),
    ].join('\n');
  }

  /**
   * Formatea el resumen de memoria auditada de aprendizaje. Si está vacío,
   * indica explícitamente que no hay patrones previos relevantes.
   */
  private formatLearning(summary: string): string {
    return summary.trim() === ''
      ? 'Memoria auditada relevante: no hay patrones previos relevantes.'
      : `Memoria auditada relevante:\n${summary}`;
  }

  /**
   * Serializa el snapshot factual autorizado como JSON indentado. Este snapshot
   * es la única fuente de datos numéricos/factuales que el modelo debe tratar
   * como verdad, frente al resto de secciones que son contextuales.
   */
  private formatSnapshot(snapshot: unknown): string {
    return `Snapshot factual autorizado:\n${JSON.stringify(snapshot, null, 2)}`;
  }

  private estimateTokens(value: string): number {
    // Heurística ligera: ~4 caracteres por token, suficiente para presupuestar
    // sin invocar un tokenizador real del modelo.
    return Math.ceil(value.length / 4);
  }
}
