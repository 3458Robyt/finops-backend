import type {
  AgentLearningContext,
  IAgentLearningContextProvider,
} from '../../../domain/interfaces/IAgentLearningService.js';
import type {
  BuiltAiContext,
  IContextEngineService,
} from '../../../domain/interfaces/IContextEngineService.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiContextOperation } from '../../../domain/models/AgentContext.js';
import {
  buildChatSystemPrompt,
  buildExecutionPlanSystemPrompt,
  buildRecommendationSystemPrompt,
  buildSnapshotQueryText,
  withBuiltContext,
} from './finOpsAiPrompts.js';
import type { TechnicalRecommendationEvidenceProvider } from './TechnicalRecommendationEvidenceService.js';
import {
  formatRecommendationEvidenceSnapshot,
  type RecommendationEvidenceSnapshot,
} from './RecommendationEvidenceSnapshot.js';
import {
  buildRecommendationReadinessReport,
  formatRecommendationReadinessForPrompt,
  type RecommendationReadinessReport,
} from './RecommendationReadinessGate.js';

/**
 * Ensamblador de contexto y prompts de la IA FinOps.
 *
 * Responsabilidad: a partir del snapshot factual y (opcionalmente) del Context
 * Engine y del contexto de aprendizaje auditado, produce el contexto construido
 * y el `systemPrompt` final para cada caso de uso (chat, recomendación y plan de
 * ejecución). Aísla del servicio la combinación `withBuiltContext` + el builder
 * de prompt correspondiente, manteniendo el servicio enfocado en la
 * orquestación y las llamadas al gateway IA.
 *
 * Importante: este módulo NO llama al gateway IA; solo consulta colaboradores de
 * contexto (Context Engine y proveedor de aprendizaje), por lo que no afecta al
 * número ni al orden de las llamadas de generación/auditoría.
 *
 * @module application/services/ai/finOpsContextAssembler
 */

/** Contexto y prompt ensamblados para una operación de chat. */
export interface AssembledChatContext {
  readonly builtContext: BuiltAiContext | undefined;
  readonly systemPrompt: string;
}

/** Contexto, prompt y contexto de aprendizaje ensamblados para recomendaciones. */
export interface AssembledRecommendationContext {
  readonly builtContext: BuiltAiContext | undefined;
  readonly systemPrompt: string;
  readonly learningContext: AgentLearningContext;
  readonly readinessReport: RecommendationReadinessReport;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
}

/** Contexto y prompt ensamblados para un plan de ejecución. */
export interface AssembledPlanContext {
  readonly builtContext: BuiltAiContext | undefined;
  readonly systemPrompt: string;
}

export class FinOpsContextAssembler {
  /**
   * @param mainModel               - Modelo principal, usado al construir contexto.
   * @param learningContextProvider - Proveedor opcional de contexto de aprendizaje auditado.
   * @param contextEngine           - Motor opcional de ensamblado de contexto.
   */
constructor(
private readonly mainModel: string,
private readonly learningContextProvider?: IAgentLearningContextProvider,
private readonly contextEngine?: IContextEngineService,
private readonly technicalEvidenceProvider?: TechnicalRecommendationEvidenceProvider,
) {}

  /**
   * Ensambla el contexto y el `systemPrompt` para una consulta de chat.
   *
   * @returns Contexto construido (o `undefined`) y el prompt de sistema final.
   */
  public async assembleChatContext(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly message: string;
    readonly snapshot: CostAnalyticsSnapshot;
  }): Promise<AssembledChatContext> {
    const builtContext = await this.buildOptionalContext({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      operation: 'CHAT',
      queryText: input.message,
      snapshot: input.snapshot,
      model: this.mainModel,
    });

    return {
      builtContext,
      systemPrompt: withBuiltContext(buildChatSystemPrompt(input.snapshot), builtContext),
    };
  }

  /**
   * Ensambla el contexto, el contexto de aprendizaje y el `systemPrompt` para la
   * generación de recomendaciones. Obtiene primero el contexto de aprendizaje y
   * luego el del motor, preservando el orden original.
   *
   * @returns Contexto construido, prompt de sistema y contexto de aprendizaje.
   */
  public async assembleRecommendationContext(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly snapshot: CostAnalyticsSnapshot;
    /** Recurso exacto para un análisis aislado; no mezcla contexto de otros recursos. */
    readonly externalResourceId?: string;
}): Promise<AssembledRecommendationContext> {
    const scoped = input.externalResourceId !== undefined;
    const learningContext = await this.getRecommendationLearningContext(input.tenantId, input.snapshot);
    const technicalEvidenceSnapshot = await this.getRecommendationTechnicalEvidenceSnapshot(
      input.tenantId,
      input.snapshot,
      input.externalResourceId,
    );
    const technicalEvidence = technicalEvidenceSnapshot === undefined
      ? undefined
      : formatRecommendationEvidenceSnapshot(technicalEvidenceSnapshot);
    const readinessReport = buildRecommendationReadinessReport({
      snapshot: input.snapshot,
      ...(technicalEvidenceSnapshot !== undefined ? { technicalEvidenceSnapshot } : {}),
    });
    const builtContext = scoped
      ? undefined
      : await this.buildOptionalContext({
          tenantId: input.tenantId,
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          operation: 'RECOMMENDATION',
          queryText: buildSnapshotQueryText(input.snapshot),
          snapshot: input.snapshot,
          model: this.mainModel,
        });

return {
      builtContext,
      systemPrompt: withBuiltContext(
        buildRecommendationSystemPrompt(
          input.snapshot,
          learningContext,
          technicalEvidence,
          formatRecommendationReadinessForPrompt(readinessReport),
          input.externalResourceId,
        ),
        builtContext,
      ),
      learningContext,
      readinessReport,
      ...(technicalEvidenceSnapshot !== undefined ? { technicalEvidenceSnapshot } : {}),
    };
  }

  /**
   * Ensambla el contexto y el `systemPrompt` para un plan de ejecución de una
   * recomendación concreta.
   *
   * @returns Contexto construido (o `undefined`) y el prompt de sistema final.
   */
  public async assembleExecutionPlanContext(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly recommendation: FinOpsRecommendation;
  }): Promise<AssembledPlanContext> {
    const builtContext = await this.buildOptionalContext({
      tenantId: input.tenantId,
      userId: input.userId,
      operation: 'EXECUTION_PLAN',
      queryText: `${input.recommendation.title} ${input.recommendation.description}`,
      snapshot: input.snapshot,
      recommendation: input.recommendation,
      model: this.mainModel,
    });

    return {
      builtContext,
      systemPrompt: withBuiltContext(
        buildExecutionPlanSystemPrompt(input.snapshot, input.recommendation),
        builtContext,
      ),
    };
  }

  /**
   * Ensambla contexto adicional con el Context Engine si está disponible.
   *
   * @returns El contexto construido, o `undefined` si no hay motor inyectado.
   */
  private async buildOptionalContext(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly operation: AiContextOperation;
    readonly queryText: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly recommendation?: FinOpsRecommendation;
    readonly model: string;
  }): Promise<BuiltAiContext | undefined> {
    if (this.contextEngine === undefined) {
      return undefined;
    }

    return this.contextEngine.buildContext(input);
  }

  /**
   * Obtiene el contexto de aprendizaje auditado para la generación de
   * recomendaciones, construyendo el texto de consulta a partir de proveedores,
   * servicios, recursos y consumo del snapshot.
   *
   * @returns Contexto de aprendizaje (limitado a 5 elementos), o un contexto
   *          vacío si no hay proveedor de aprendizaje inyectado.
   */
  private async getRecommendationLearningContext(
    tenantId: string,
    snapshot: CostAnalyticsSnapshot,
  ): Promise<AgentLearningContext> {
    if (this.learningContextProvider === undefined) {
      return {
        memoryIds: [],
        caseIds: [],
        summary: '',
      };
    }

return this.learningContextProvider.getRecommendationLearningContext({
tenantId,
queryText: buildSnapshotQueryText(snapshot, true),
limit: 5,
});
}

private async getRecommendationTechnicalEvidenceSnapshot(
tenantId: string,
snapshot: CostAnalyticsSnapshot,
externalResourceId?: string,
): Promise<RecommendationEvidenceSnapshot | undefined> {
if (this.technicalEvidenceProvider === undefined) {
return undefined;
}

return this.technicalEvidenceProvider.buildRecommendationEvidenceSnapshot({
  tenantId,
  snapshot,
  ...(externalResourceId !== undefined ? { externalResourceId } : {}),
});
}
}
