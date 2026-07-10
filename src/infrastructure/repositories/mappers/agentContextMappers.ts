/**
 * Mappers puros y tipos de fila cruda del repositorio de contexto del agente IA.
 *
 * Responsabilidad: aislar la traducción `fila Prisma`/`fila cruda ($queryRaw)`
 * -> modelo de dominio de las entidades del contexto del agente (perfiles de
 * instrucciones, reglas por tenant, trazas de contexto IA, artefactos de
 * resumen, agregaciones FOCUS y grafo de conocimiento), junto con la interfaz
 * que describe la forma de la fila agregada FOCUS. Todas las funciones aquí son
 * puras (no dependen de `this` ni del cliente Prisma) para mantener el
 * repositorio enfocado en el acceso a datos.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 */
import type { FocusResourcePeriodAggregate } from '../../../domain/interfaces/IAgentContextRepository.js';
import type {
  AgentInstructionProfile,
  AiContextTrace,
  ContextArtifact,
  TenantAgentRule,
} from '../../../domain/models/AgentContext.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

/**
 * Fila cruda de la agregación FOCUS por recurso y periodo mensual (consulta
 * `$queryRaw`). Los importes/cantidades se castean a `float8` en SQL para
 * devolver `number` en lugar de `Decimal`; `consumed_quantity`/`consumed_unit`
 * pueden ser `null` cuando el recurso mezcla varias unidades de consumo.
 */
export interface FocusAggregateRow {
  readonly tenant_id: string;
  readonly provider: string;
  readonly cloud_account_id: string;
  readonly service_name: string;
  readonly resource_id: string;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly billed_cost: number;
  readonly consumed_quantity: number | null;
  readonly consumed_unit: string | null;
  readonly currency: string;
  readonly metric_count: number;
}

/**
 * Mapea una fila de `agent_instruction_profiles` (Prisma) al modelo de dominio
 * {@link AgentInstructionProfile}.
 *
 * Casos borde: `status` se castea al tipo de unión del dominio;
 * `structuredRules`/`validationReport` se exponen como sus tipos JSON de
 * dominio; los campos anulables (`freeformNotes`, `validationReport`,
 * `activatedAt`, `activatedByUserId`) solo se incluyen cuando no son `null`.
 *
 * @param row Fila del perfil de instrucciones de Prisma.
 * @returns Perfil de instrucciones de dominio.
 */
export function toProfile(row: {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly structuredRules: unknown;
  readonly freeformNotes: string | null;
  readonly validationReport: unknown;
  readonly activatedAt: Date | null;
  readonly createdByUserId: string;
  readonly activatedByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): AgentInstructionProfile {
  return {
    id: row.id,
    version: row.version,
    status: row.status as AgentInstructionProfile['status'],
    structuredRules: row.structuredRules as AgentInstructionProfile['structuredRules'],
    ...(row.freeformNotes !== null ? { freeformNotes: row.freeformNotes } : {}),
    ...(row.validationReport !== null
      ? { validationReport: row.validationReport as AgentInstructionProfile['validationReport'] }
      : {}),
    ...(row.activatedAt !== null ? { activatedAt: row.activatedAt } : {}),
    createdByUserId: row.createdByUserId,
    ...(row.activatedByUserId !== null ? { activatedByUserId: row.activatedByUserId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Mapea una fila de `tenant_agent_rules` (Prisma) al modelo de dominio
 * {@link TenantAgentRule}.
 *
 * Casos borde: `status` se castea al tipo de unión del dominio; `disabledAt`
 * solo se incluye cuando no es `null`.
 *
 * @param row Fila de la regla de tenant de Prisma.
 * @returns Regla de tenant de dominio.
 */
export function toTenantRule(row: {
  readonly id: string;
  readonly tenantId: string;
  readonly category: string;
  readonly ruleText: string;
  readonly priority: number;
  readonly status: string;
  readonly disabledAt: Date | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): TenantAgentRule {
  return {
    id: row.id,
    tenantId: row.tenantId,
    category: row.category,
    ruleText: row.ruleText,
    priority: row.priority,
    status: row.status as TenantAgentRule['status'],
    ...(row.disabledAt !== null ? { disabledAt: row.disabledAt } : {}),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Mapea una fila de `ai_context_traces` (Prisma) al modelo de dominio
 * {@link AiContextTrace}.
 *
 * Casos borde: `operation` se castea al tipo de unión del dominio; los campos
 * anulables (`userId`, `profileVersion`, `responseTokenEstimate`, `latencyMs`)
 * solo se incluyen cuando no son `null`.
 *
 * @param row Fila de la traza de contexto IA de Prisma.
 * @returns Traza de contexto IA de dominio.
 */
export function toTrace(row: {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly operation: string;
  readonly model: string;
  readonly status: string;
  readonly profileVersion: number | null;
  readonly promptTokenEstimate: number;
  readonly responseTokenEstimate: number | null;
  readonly latencyMs: number | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}): AiContextTrace {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...(row.userId !== null ? { userId: row.userId } : {}),
    operation: row.operation as AiContextTrace['operation'],
    model: row.model,
    status: row.status,
    ...(row.profileVersion !== null ? { profileVersion: row.profileVersion } : {}),
    promptTokenEstimate: row.promptTokenEstimate,
    ...(row.responseTokenEstimate !== null ? { responseTokenEstimate: row.responseTokenEstimate } : {}),
    ...(row.latencyMs !== null ? { latencyMs: row.latencyMs } : {}),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Mapea una fila de `context_summary_cache` (Prisma) al artefacto de contexto
 * de dominio {@link ContextArtifact}.
 *
 * Casos borde: los campos anulables (`provider`, `cloudAccountId`,
 * `serviceName`, `resourceId`, `evidenceRefs`) solo se incluyen cuando no son
 * `null`; `evidenceRefs` se expone tal cual (JSON).
 *
 * @param row Fila del resumen de contexto cacheado de Prisma.
 * @returns Artefacto de contexto de dominio.
 */
export function toContextArtifact(
  row: Awaited<ReturnType<PrismaClient['contextSummaryCache']['findFirst']>> & {},
): ContextArtifact {
  return {
    id: row.id,
    artifactType: row.artifactType,
    scopeKey: row.scopeKey,
    summary: row.summary,
    tokenEstimate: row.tokenEstimate,
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.cloudAccountId !== null ? { cloudAccountId: row.cloudAccountId } : {}),
    ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
    ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
    ...(row.evidenceRefs !== null ? { evidenceRefs: row.evidenceRefs } : {}),
  };
}

/**
 * Mapea una fila cruda de agregación FOCUS ({@link FocusAggregateRow}) al
 * modelo de dominio {@link FocusResourcePeriodAggregate}.
 *
 * Casos borde: los campos de consumo anulables (`consumedQuantity`,
 * `consumedUnit`) solo se incluyen cuando no son `null` (unidades mixtas en el
 * grupo).
 *
 * @param row Fila cruda de agregación FOCUS.
 * @returns Agregación por recurso/periodo de dominio.
 */
export function toFocusResourcePeriodAggregate(row: FocusAggregateRow): FocusResourcePeriodAggregate {
  return {
    tenantId: row.tenant_id,
    provider: row.provider,
    cloudAccountId: row.cloud_account_id,
    serviceName: row.service_name,
    resourceId: row.resource_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    billedCost: row.billed_cost,
    ...(row.consumed_quantity !== null ? { consumedQuantity: row.consumed_quantity } : {}),
    ...(row.consumed_unit !== null ? { consumedUnit: row.consumed_unit } : {}),
    currency: row.currency,
    metricCount: row.metric_count,
  };
}

