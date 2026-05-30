import type { BuiltAiContext } from '../../../domain/interfaces/IContextEngineService.js';
import type { AiContextOperation } from '../../../domain/models/AgentContext.js';
import type { AiObservabilityService } from '../AiObservabilityService.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Registrador de trazas de observabilidad IA
 * ═══════════════════════════════════════════════════════════════
 *
 * Encapsula el registro best-effort de trazas de cada llamada al proveedor IA
 * (operación, modelo, latencia, estimación de tokens e identificadores de
 * contexto usados). Si no hay servicio de observabilidad inyectado, no hace
 * nada. Se extrae del servicio para separar la telemetría de la orquestación.
 *
 * @module application/services/ai/aiTraceRecorder
 */

/** Parámetros de una traza de llamada IA. */
export interface AiTraceInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly operation: AiContextOperation;
  readonly model: string;
  readonly builtContext?: BuiltAiContext;
  /** Marca de inicio (`Date.now()`) para calcular la latencia. */
  readonly startedAt: number;
  /** Texto de respuesta del modelo, si lo hubo. */
  readonly responseText?: string;
  /** Error capturado, si la llamada falló. */
  readonly error?: unknown;
}

/**
 * Registrador de trazas IA sobre el servicio de observabilidad opcional.
 */
export class AiTraceRecorder {
  /**
   * @param observability - Servicio de observabilidad opcional; si es
   *                        `undefined`, {@link record} es una operación nula.
   */
  constructor(private readonly observability?: AiObservabilityService) {}

  /**
   * Registra una traza de observabilidad de una llamada IA.
   *
   * Captura modelo, operación, estado (SUCCESS/ERROR), latencia, estimación de
   * tokens del prompt y los identificadores de contexto usados (artefactos,
   * memorias, nodos de conocimiento, reglas de tenant y conflictos). No lanza;
   * es un efecto secundario best-effort.
   */
  public async record(input: AiTraceInput): Promise<void> {
    if (this.observability === undefined) {
      return;
    }

    const { builtContext, error } = input;

    await this.observability.recordTrace({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      operation: input.operation,
      model: input.model,
      status: error === undefined ? 'SUCCESS' : 'ERROR',
      ...(builtContext?.profileVersion !== undefined ? { profileVersion: builtContext.profileVersion } : {}),
      promptTokenEstimate: builtContext?.promptTokenEstimate ?? 0,
      ...(input.responseText !== undefined ? { responseText: input.responseText } : {}),
      latencyMs: Date.now() - input.startedAt,
      ...(builtContext !== undefined ? { artifactIds: builtContext.artifactIds } : {}),
      ...(builtContext !== undefined ? { memoryIds: builtContext.memoryIds } : {}),
      ...(builtContext !== undefined ? { knowledgeNodeIds: builtContext.knowledgeNodeIds } : {}),
      ...(builtContext !== undefined ? { tenantRuleIds: builtContext.tenantRuleIds } : {}),
      ...(builtContext !== undefined ? { conflicts: builtContext.conflicts } : {}),
      ...(error !== undefined
        ? { errorMessage: error instanceof Error ? error.message : 'AI call failed' }
        : {}),
    });
  }
}
