import type { CreateAgentMemoryInput } from '../../../domain/interfaces/IAgentLearningRepository.js';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Escrituras del grafo de conocimiento del agente
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla la persistencia de nodos y aristas del grafo de conocimiento
 * (`agent_knowledge_nodes`, `agent_knowledge_edges`) del repositorio de
 * aprendizaje: el alta idempotente de nodos y el enlazado de una memoria con su
 * evento de origen (`DERIVED_FROM`). Las operaciones por tenant aplican
 * aislamiento multi-tenant, salvo los nodos/aristas de ámbito `GLOBAL`.
 *
 * Importante: este módulo NO importa del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/agentKnowledgeGraphWrites
 */

/**
 * Asegura (idempotente) la existencia de un nodo en el grafo de conocimiento.
 *
 * Comprueba primero si ya existe un nodo con el mismo `tenantId`, `nodeType` y
 * `externalId` (aislamiento multi-tenant); si existe, no hace nada. Si no, lo
 * crea. `metadata` se serializa como JSON de Prisma. Evita duplicar nodos al
 * registrar repetidamente la misma entidad.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos del nodo (tenant, ámbito, tipo, id externo, etiqueta y
 *   metadatos).
 * @returns Promesa que se resuelve cuando el nodo existe (creado o ya presente).
 */
export async function upsertKnowledgeNode(
  prisma: PrismaClient,
  input: {
    readonly tenantId: string;
    readonly scope: 'LOCAL' | 'GLOBAL';
    readonly nodeType: string;
    readonly externalId: string;
    readonly label: string;
    readonly metadata: unknown;
  },
): Promise<void> {
  const existing = await prisma.agentKnowledgeNode.findFirst({
    where: {
      tenantId: input.tenantId,
      nodeType: input.nodeType,
      externalId: input.externalId,
    },
  });

  if (existing !== null) {
    return;
  }

  await prisma.agentKnowledgeNode.create({
    data: {
      tenantId: input.tenantId,
      scope: input.scope,
      nodeType: input.nodeType,
      externalId: input.externalId,
      label: input.label,
      metadata: input.metadata as Prisma.InputJsonValue,
    },
  });
}

/**
 * Enlaza una memoria recién creada con su evento de origen en el grafo de
 * conocimiento, dentro de una transacción ya abierta.
 *
 * Crea un nodo de tipo `memory` y otro de tipo `learning_event`, y una arista
 * `DERIVED_FROM` entre ambos registrando la confianza. Deja trazada la
 * procedencia del aprendizaje. El `tenantId` es opcional porque las memorias
 * `GLOBAL` no pertenecen a un tenant.
 *
 * @param tx Cliente transaccional de Prisma (la transacción la abre el repositorio).
 * @param input Datos de la memoria y su evento de origen.
 * @param memoryId Identificador de la memoria ya creada (id externo del nodo `memory`).
 * @returns Promesa que se resuelve cuando los nodos y la arista se han creado.
 */
export async function linkMemoryToGraph(
  tx: Prisma.TransactionClient,
  input: CreateAgentMemoryInput,
  memoryId: string,
): Promise<void> {
  const memoryNode = await tx.agentKnowledgeNode.create({
    data: {
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      scope: input.scope,
      nodeType: 'memory',
      externalId: memoryId,
      label: input.memoryType,
      metadata: {
        fingerprint: input.fingerprint,
        memoryType: input.memoryType,
      },
    },
  });

  const eventNode = await tx.agentKnowledgeNode.create({
    data: {
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      scope: input.scope,
      nodeType: 'learning_event',
      externalId: input.sourceLearningEventId,
      label: 'Learning event',
      metadata: {
        sourceLearningEventId: input.sourceLearningEventId,
      },
    },
  });

  await tx.agentKnowledgeEdge.create({
    data: {
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      sourceNodeId: memoryNode.id,
      targetNodeId: eventNode.id,
      relationType: 'DERIVED_FROM',
      confidence: input.confidence,
      sourceLearningEventId: input.sourceLearningEventId,
    },
  });
}
