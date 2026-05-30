import type { KnowledgeGraphContext } from '../../../domain/models/AgentContext.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { toKnowledgeGraphEdge, toKnowledgeGraphNode } from '../mappers/agentContextMappers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Consultas del grafo de conocimiento del agente IA
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla la lógica de recuperación del subgrafo de conocimiento
 * (`agent_knowledge_nodes`/`agent_knowledge_edges`) del repositorio de contexto
 * del agente: la vista general acotada y el recorrido tipo BFS por niveles con
 * profundidad acotada. Recibe el cliente Prisma por parámetro y devuelve el
 * subgrafo ya mapeado a dominio mediante los mappers puros. Filtra siempre por
 * `tenantId` (aislamiento multi-tenant).
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos);
 * depende únicamente de los mappers puros y de los tipos de dominio.
 *
 * @module infrastructure/repositories/queries/agentKnowledgeGraphQueries
 */

/**
 * Recupera un subgrafo del grafo de conocimiento del agente para un tenant.
 *
 * Dos modos de operación:
 * - Sin `recommendationId` ni `resourceId`: devuelve una vista general acotada
 *   (hasta 250 nodos y 500 aristas más recientes), filtrando las aristas para
 *   conservar solo aquellas cuyos extremos son nodos visibles.
 * - Con `recommendationId` o `resourceId`: realiza un recorrido tipo BFS desde
 *   los nodos semilla coincidentes (por `externalId`), expandiendo la frontera
 *   por niveles hasta una profundidad acotada (`depth`, limitada al rango 1..2)
 *   y recolectando los nodos y aristas alcanzados.
 *
 * Siempre filtra por `tenantId` (aislamiento multi-tenant). Los campos
 * anulables de nodos/aristas (`externalId`, `metadata`) solo se incluyen cuando
 * no son `null`.
 *
 * @param prisma Cliente Prisma.
 * @param input  Tenant, filtros opcionales por recomendación/recurso y
 *   profundidad de expansión.
 * @returns El subgrafo (nodos y aristas) en formato de dominio; vacío si no hay
 *   nodos semilla en el modo dirigido.
 */
export async function getKnowledgeGraph(
  prisma: PrismaClient,
  input: {
    readonly tenantId: string;
    readonly recommendationId?: string;
    readonly resourceId?: string;
    readonly depth: number;
  },
): Promise<KnowledgeGraphContext> {
  if (input.recommendationId === undefined && input.resourceId === undefined) {
    const [nodes, edges] = await Promise.all([
      prisma.agentKnowledgeNode.findMany({
        where: { tenantId: input.tenantId },
        orderBy: [
          { nodeType: 'asc' },
          { createdAt: 'desc' },
        ],
        take: 250,
      }),
      prisma.agentKnowledgeEdge.findMany({
        where: { tenantId: input.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    ]);

    const visibleNodeIds = new Set(nodes.map((node) => node.id));

    return {
      nodes: nodes.map(toKnowledgeGraphNode),
      edges: edges
        .filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
        .map(toKnowledgeGraphEdge),
    };
  }

  const startNodes = await prisma.agentKnowledgeNode.findMany({
    where: {
      tenantId: input.tenantId,
      OR: [
        ...(input.recommendationId !== undefined
          ? [{ nodeType: 'recommendation', externalId: input.recommendationId }]
          : []),
        ...(input.resourceId !== undefined
          ? [{ nodeType: 'resource_period', externalId: { startsWith: `${input.resourceId}:` } }]
          : []),
      ],
    },
    take: 20,
  });

  if (startNodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeIds = new Set(startNodes.map((node) => node.id));
  let frontier = startNodes.map((node) => node.id);
  const collectedEdges = new Map<string, Awaited<ReturnType<typeof prisma.agentKnowledgeEdge.findMany>>[number]>();

  // Recorrido BFS por niveles: en cada nivel se buscan las aristas incidentes
  // a la frontera actual (como origen o destino), se acumulan y se descubren
  // nuevos nodos para la siguiente frontera. La profundidad se acota a 1..2
  // para limitar el tamaño del subgrafo y el coste de las consultas.
  for (let level = 0; level < Math.max(1, Math.min(input.depth, 2)); level += 1) {
    const edges = await prisma.agentKnowledgeEdge.findMany({
      where: {
        tenantId: input.tenantId,
        OR: [
          { sourceNodeId: { in: frontier } },
          { targetNodeId: { in: frontier } },
        ],
      },
    });

    frontier = [];

    for (const edge of edges) {
      collectedEdges.set(edge.id, edge);
      if (!nodeIds.has(edge.sourceNodeId)) {
        nodeIds.add(edge.sourceNodeId);
        frontier.push(edge.sourceNodeId);
      }
      if (!nodeIds.has(edge.targetNodeId)) {
        nodeIds.add(edge.targetNodeId);
        frontier.push(edge.targetNodeId);
      }
    }
  }

  const nodes = await prisma.agentKnowledgeNode.findMany({
    where: { id: { in: [...nodeIds] } },
  });

  return {
    nodes: nodes.map(toKnowledgeGraphNode),
    edges: [...collectedEdges.values()].map(toKnowledgeGraphEdge),
  };
}
