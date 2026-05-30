import type {
  UpsertKnowledgeEdgeInput,
  UpsertKnowledgeNodeInput,
} from '../../../domain/interfaces/IAgentContextRepository.js';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Escrituras del grafo de conocimiento del contexto del agente
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla del repositorio de contexto el upsert de nodos y aristas del grafo de
 * conocimiento (`agent_knowledge_nodes`/`agent_knowledge_edges`). La unicidad se
 * basa en `tenantId` + `dedupeKey` (aislamiento multi-tenant y deduplicación).
 *
 * Importante: este módulo NO importa del repositorio (evita ciclos). Difiere de
 * las escrituras de grafo del repositorio de aprendizaje, que usan idempotencia
 * por `externalId` dentro de una transacción.
 *
 * @module infrastructure/repositories/queries/agentContextGraphWrites
 */

/**
 * Inserta o actualiza (upsert) un nodo del grafo de conocimiento del agente.
 *
 * La unicidad se basa en `tenantId` + `dedupeKey` (aislamiento multi-tenant y
 * deduplicación): si el nodo ya existe, actualiza etiqueta/metadatos; si no, lo
 * crea con su tipo y ámbito. `metadata` se serializa como JSON de Prisma.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos del nodo (tenant, ámbito, tipo, clave de deduplicación,
 *   etiqueta y metadatos opcionales).
 * @returns El identificador del nodo creado o actualizado.
 */
export async function upsertKnowledgeNode(
  prisma: PrismaClient,
  input: UpsertKnowledgeNodeInput,
): Promise<string> {
  const row = await prisma.agentKnowledgeNode.upsert({
    where: {
      tenantId_dedupeKey: {
        tenantId: input.tenantId,
        dedupeKey: input.dedupeKey,
      },
    },
    update: {
      label: input.label,
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
    },
    create: {
      tenantId: input.tenantId,
      scope: input.scope,
      nodeType: input.nodeType,
      dedupeKey: input.dedupeKey,
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      label: input.label,
      ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
    },
  });

  return row.id;
}

/**
 * Inserta o actualiza (upsert) una arista del grafo de conocimiento que conecta
 * dos nodos.
 *
 * La unicidad se basa en `tenantId` + `dedupeKey`: si la arista ya existe,
 * actualiza la confianza/metadatos; si no, la crea con su tipo de relación y los
 * nodos origen/destino. `confidence` representa el grado de confianza de la
 * relación; `metadata` se serializa como JSON de Prisma.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos de la arista (tenant, nodos origen/destino, tipo de
 *   relación, clave de deduplicación, confianza y metadatos opcionales).
 * @returns El identificador de la arista creada o actualizada.
 */
export async function upsertKnowledgeEdge(
  prisma: PrismaClient,
  input: UpsertKnowledgeEdgeInput,
): Promise<string> {
  const row = await prisma.agentKnowledgeEdge.upsert({
    where: {
      tenantId_dedupeKey: {
        tenantId: input.tenantId,
        dedupeKey: input.dedupeKey,
      },
    },
    update: {
      confidence: input.confidence,
      ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
    },
    create: {
      tenantId: input.tenantId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      relationType: input.relationType,
      dedupeKey: input.dedupeKey,
      confidence: input.confidence,
      ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
    },
  });

  return row.id;
}
