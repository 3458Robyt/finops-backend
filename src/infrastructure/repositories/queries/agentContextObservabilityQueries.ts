import type {
  CompleteContextBuildRunInput,
  CreateAiContextTraceInput,
  CreateContextBuildRunInput,
} from '../../../domain/interfaces/IAgentContextRepository.js';
import type { AiContextTrace } from '../../../domain/models/AgentContext.js';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';
import { toTrace } from '../mappers/agentContextMappers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas de observabilidad del contexto del agente
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla del repositorio de contexto el registro y la consulta de trazas de
 * contexto IA (`ai_context_traces`) y las ejecuciones de construcción de
 * contexto (`context_build_runs`). Todas las operaciones por tenant aplican
 * aislamiento multi-tenant.
 *
 * Importante: este módulo NO importa del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/agentContextObservabilityQueries
 */

/**
 * Crea una traza de contexto IA (`ai_context_traces`) que registra una
 * operación del agente (modelo, estado, tokens, latencia, artefactos/memorias
 * usados, conflictos, etc.) para observabilidad.
 *
 * Establece una expiración (`expiresAt`) a 180 días desde ahora (retención de
 * trazas). Los arreglos de identificadores se copian con spread; los campos
 * opcionales solo se incluyen cuando están definidos.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos de la traza a registrar.
 * @returns La traza creada en formato de dominio.
 */
export async function createAiContextTrace(
  prisma: PrismaClient,
  input: CreateAiContextTraceInput,
): Promise<AiContextTrace> {
  const row = await prisma.aiContextTrace.create({
    data: {
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      operation: input.operation,
      model: input.model,
      status: input.status,
      ...(input.profileVersion !== undefined ? { profileVersion: input.profileVersion } : {}),
      promptTokenEstimate: input.promptTokenEstimate,
      ...(input.responseTokenEstimate !== undefined ? { responseTokenEstimate: input.responseTokenEstimate } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.artifactIds !== undefined ? { artifactIds: [...input.artifactIds] } : {}),
      ...(input.memoryIds !== undefined ? { memoryIds: [...input.memoryIds] } : {}),
      ...(input.knowledgeNodeIds !== undefined ? { knowledgeNodeIds: [...input.knowledgeNodeIds] } : {}),
      ...(input.tenantRuleIds !== undefined ? { tenantRuleIds: [...input.tenantRuleIds] } : {}),
      ...(input.conflicts !== undefined ? { conflicts: [...input.conflicts] } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    },
  });

  return toTrace(row);
}

/**
 * Lista las trazas de contexto IA de un tenant, de la más reciente a la más
 * antigua.
 *
 * @param prisma Cliente Prisma.
 * @param input Tenant (aislamiento multi-tenant) y límite de resultados.
 * @returns Lista de trazas de dominio; arreglo vacío si no hay ninguna.
 */
export async function listAiContextTraces(
  prisma: PrismaClient,
  input: {
    readonly tenantId: string;
    readonly limit: number;
  },
): Promise<AiContextTrace[]> {
  const rows = await prisma.aiContextTrace.findMany({
    where: { tenantId: input.tenantId },
    orderBy: { createdAt: 'desc' },
    take: input.limit,
  });

  return rows.map(toTrace);
}

/**
 * Inicia una ejecución de construcción de contexto (`context_build_runs`) en
 * estado `RUNNING`, registrando su inicio.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos de la ejecución (tenant, tipo de run, autor y metadatos
 *   opcionales). `metadata` se serializa como JSON de Prisma.
 * @returns El identificador de la ejecución creada.
 */
export async function createContextBuildRun(
  prisma: PrismaClient,
  input: CreateContextBuildRunInput,
): Promise<string> {
  const row = await prisma.contextBuildRun.create({
    data: {
      tenantId: input.tenantId,
      runType: input.runType,
      status: 'RUNNING',
      startedAt: new Date(),
      ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
    },
  });

  return row.id;
}

/**
 * Finaliza una ejecución de construcción de contexto, registrando su estado
 * final y la marca de finalización.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos de cierre (id de la ejecución, estado, mensaje de error
 *   opcional y metadatos opcionales). `metadata` se serializa como JSON.
 * @returns Promesa que se resuelve cuando la actualización finaliza.
 */
export async function completeContextBuildRun(
  prisma: PrismaClient,
  input: CompleteContextBuildRunInput,
): Promise<void> {
  await prisma.contextBuildRun.update({
    where: { id: input.runId },
    data: {
      status: input.status,
      completedAt: new Date(),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
    },
  });
}
