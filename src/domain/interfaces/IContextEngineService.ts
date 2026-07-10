import type { CostAnalyticsSnapshot } from './ICostAnalyticsRepository.js';
import type { AiContextOperation } from '../models/AgentContext.js';
import type { FinOpsRecommendation } from '../models/FinOpsRecommendation.js';

/**
 * Parámetros de entrada para construir el contexto que se enviará al modelo de IA.
 *
 * Reúne la consulta, el snapshot de costos y, opcionalmente, una recomendación,
 * para que el motor de contexto ensamble instrucciones y evidencia relevantes.
 */
export interface BuildAiContextInput {
  readonly tenantId: string;
  /** Usuario que origina la operación; opcional cuando el contexto es a nivel de sistema. */
  readonly userId?: string;
  /** Tipo de operación de IA para la cual se construye el contexto. */
  readonly operation: AiContextOperation;
  /** Texto de la consulta o intención que guía la recuperación de contexto. */
  readonly queryText: string;
  /** Snapshot analítico de costos que aporta los datos cuantitativos del contexto. */
  readonly snapshot: CostAnalyticsSnapshot;
  /** Recomendación asociada cuando el contexto se construye en torno a una recomendación concreta. */
  readonly recommendation?: FinOpsRecommendation;
  /** Modelo objetivo para el cual se optimiza el contexto (afecta estimaciones de tokens). */
  readonly model: string;
}

/**
 * Contexto de IA ya ensamblado, listo para componer el prompt final.
 *
 * Incluye el texto a enviar al modelo junto con la trazabilidad de las fuentes
 * (artefactos, memorias, casos y reglas de tenant) utilizadas.
 */
export interface BuiltAiContext {
  /** Instrucciones de sistema (perfil del agente y reglas) que condicionan el comportamiento del modelo. */
  readonly systemInstructions: string;
  /** Texto de contexto con la evidencia recopilada para la consulta. */
  readonly contextText: string;
  /** Identificadores de los artefactos de contexto incluidos; usados para trazabilidad. */
  readonly artifactIds: readonly string[];
  /** Identificadores de las memorias del agente incorporadas. */
  readonly memoryIds: readonly string[];
  /** Identificadores de los casos de aprendizaje incorporados. */
  readonly caseIds: readonly string[];
  /** Identificadores de las reglas de tenant aplicadas. */
  readonly tenantRuleIds: readonly string[];
  /** Conflictos detectados entre reglas o fuentes durante el ensamblado. */
  readonly conflicts: readonly string[];
  /** Versión del perfil de instrucciones del agente utilizado; presente si hay un perfil activo. */
  readonly profileVersion?: number;
  /** Estimación de tokens del prompt resultante, útil para control de costos y límites. */
  readonly promptTokenEstimate: number;
}

/**
 * Contrato del motor de construcción de contexto para la IA.
 *
 * Puerto de dominio que orquesta la recuperación y el ensamblado de contexto
 * (RAG) a partir de costos, memorias, conocimiento y reglas. La implementación
 * concreta reside en la capa de aplicación/infraestructura.
 */
export interface IContextEngineService {
  /**
   * Construye el contexto de IA a partir de los datos de entrada.
   *
   * @param input - Consulta, snapshot de costos y metadatos de la operación.
   * @returns Contexto ensamblado con instrucciones, evidencia y trazabilidad de fuentes.
   */
  buildContext(input: BuildAiContextInput): Promise<BuiltAiContext>;
}
