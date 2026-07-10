/**
 * Mappers puros y tipos de fila cruda del repositorio de aprendizaje del agente.
 *
 * Responsabilidad: aislar la traducción `fila Prisma`/`fila cruda ($queryRaw)`
 * -> modelo de dominio de las entidades de aprendizaje del agente (eventos de
 * aprendizaje, memorias, contexto y resúmenes), junto con las interfaces que
 * describen la forma de las filas crudas de las búsquedas de texto completo y
 * los conteos de patrones. Todas las funciones aquí son puras (no dependen de
 * `this` ni del cliente Prisma) para mantener el repositorio enfocado en el
 * acceso a datos.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 */
import type { AgentLearningSummary } from '../../../domain/interfaces/IAgentLearningService.js';
import type { AgentLearningEvent, AgentMemory } from '../../../domain/models/AgentLearning.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

/**
 * Fila cruda de la consulta de memorias relevantes (búsqueda de texto completo).
 * `confidence` se castea a `float8` en SQL para devolver `number` en lugar de
 * `Decimal`.
 */
export interface MemoryContextRow {
  readonly id: string;
  readonly scope: string;
  readonly memory_type: string;
  readonly content: string;
  readonly confidence: number;
  readonly created_at: Date;
}

/**
 * Fila cruda de la consulta de casos previos (decisiones sobre recomendaciones)
 * usada como contexto de aprendizaje. `reason_code`/`reason` pueden ser `null`.
 */
export interface CaseContextRow {
  readonly decision_id: string;
  readonly decision: string;
  readonly reason_code: string | null;
  readonly reason: string | null;
  readonly recommendation_type: string;
  readonly title: string;
  readonly description: string;
  readonly created_at: Date;
}

/**
 * Fila cruda del recuento de patrones similares: número de eventos y de tenants
 * distintos que comparten el patrón (ambos casteados a `int` en SQL).
 */
export interface PatternCountRow {
  readonly event_count: number;
  readonly tenant_count: number;
}

/**
 * Mapea una fila de `agent_learning_events` (Prisma) al modelo de dominio
 * {@link AgentLearningEvent}.
 *
 * Casos borde: los campos de auditoría anulables (`auditVerdict`, `auditScore`)
 * solo se incluyen cuando no son `null`.
 *
 * @param row Fila del evento de aprendizaje de Prisma.
 * @returns Evento de aprendizaje de dominio.
 */
export function toLearningEvent(
  row: Awaited<ReturnType<PrismaClient['agentLearningEvent']['findFirst']>> & {},
): AgentLearningEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    recommendationId: row.recommendationId,
    decisionId: row.decisionId,
    status: row.status,
    ...(row.auditVerdict !== null ? { auditVerdict: row.auditVerdict } : {}),
    ...(row.auditScore !== null ? { auditScore: row.auditScore } : {}),
    createdAt: row.createdAt,
  };
}

/**
 * Mapea una fila de `agent_memory` (Prisma) al modelo de dominio
 * {@link AgentMemory}.
 *
 * Casos borde: `tenantId` solo se incluye cuando no es `null` (las memorias
 * `GLOBAL` no tienen tenant asociado).
 *
 * @param row Fila de la memoria del agente de Prisma.
 * @returns Memoria del agente de dominio.
 */
export function toMemory(row: Awaited<ReturnType<PrismaClient['agentMemory']['findFirst']>> & {}): AgentMemory {
  return {
    id: row.id,
    ...(row.tenantId !== null ? { tenantId: row.tenantId } : {}),
    scope: row.scope,
    memoryType: row.memoryType,
    content: row.content,
    confidence: row.confidence,
    active: row.active,
    createdAt: row.createdAt,
  };
}

/**
 * Mapea una fila de `agent_memory` (Prisma) al item de memoria del resumen de
 * aprendizaje {@link AgentLearningSummary}, proyectando solo los campos
 * necesarios para los paneles de observabilidad.
 *
 * @param memory Fila de la memoria del agente de Prisma.
 * @returns Item de memoria del resumen.
 */
export function toSummaryMemory(
  memory: Awaited<ReturnType<PrismaClient['agentMemory']['findFirst']>> & {},
): AgentLearningSummary['memories'][number] {
  return {
    id: memory.id,
    scope: memory.scope,
    memoryType: memory.memoryType,
    content: memory.content,
    confidence: memory.confidence,
    createdAt: memory.createdAt,
  };
}

/**
 * Mapea una fila de `agent_learning_events` (Prisma) al item de evento del
 * resumen de aprendizaje {@link AgentLearningSummary}, proyectando solo los
 * campos necesarios para los paneles de observabilidad.
 *
 * @param event Fila del evento de aprendizaje de Prisma.
 * @returns Item de evento del resumen.
 */
export function toSummaryEvent(
  event: Awaited<ReturnType<PrismaClient['agentLearningEvent']['findFirst']>> & {},
): AgentLearningSummary['events'][number] {
  return {
    id: event.id,
    recommendationId: event.recommendationId,
    decisionId: event.decisionId,
    status: event.status,
    createdAt: event.createdAt,
  };
}

/**
 * Compone la línea textual de una memoria para el resumen de contexto de
 * aprendizaje (una línea por memoria relevante).
 *
 * @param memory Fila cruda de memoria de la búsqueda de texto completo.
 * @returns Línea de texto con ámbito, tipo y contenido de la memoria.
 */
export function toMemoryContextLine(memory: MemoryContextRow): string {
  return `Memoria ${memory.scope}/${memory.memory_type}: ${memory.content}`;
}

/**
 * Compone la línea textual de un caso previo para el resumen de contexto de
 * aprendizaje (una línea por caso).
 *
 * Casos borde: usa `'SIN_MOTIVO'` cuando `reason_code` es `null` y recurre a la
 * descripción cuando `reason` es `null`.
 *
 * @param item Fila cruda del caso previo de la búsqueda de texto completo.
 * @returns Línea de texto con decisión, motivo, tipo y título del caso.
 */
export function toCaseContextLine(item: CaseContextRow): string {
  return `Caso ${item.decision} (${item.reason_code ?? 'SIN_MOTIVO'}) en ${item.recommendation_type}: ${item.title}. ${item.reason ?? item.description}`;
}
