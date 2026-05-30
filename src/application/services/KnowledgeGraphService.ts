import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type { KnowledgeGraphContext } from '../../domain/models/AgentContext.js';

/**
 * Servicio de aplicación que construye y consulta el grafo de conocimiento
 * FinOps. A partir de los agregados FOCUS materializa nodos (proveedor, cuenta
 * cloud, servicio, recurso-periodo) y aristas de relación entre ellos, y expone
 * la recuperación de subgrafos contextuales para enriquecer las respuestas del
 * agente de IA.
 *
 * Colaborador inyectado:
 * - {@link IAgentContextRepository}: persistencia de corridas de build, upsert de
 *   nodos/aristas del grafo y consulta del grafo contextual.
 *
 * Rol dentro del flujo: provee la representación en grafo del entorno cloud que
 * el Context Engine puede usar como evidencia estructurada de relaciones.
 */
export class KnowledgeGraphService {
  constructor(private readonly repository: IAgentContextRepository) {}

  /**
   * Reconstruye (backfill) el grafo de conocimiento de un tenant a partir de los
   * agregados FOCUS por recurso y periodo.
   *
   * Crea una corrida de build y, por cada agregado, hace upsert de cuatro nodos
   * (proveedor, cuenta, servicio y recurso-periodo) usando claves de
   * deduplicación deterministas, y luego crea las aristas de relación
   * (BELONGS_TO, USES_SERVICE) entre ellos. Al terminar marca la corrida como
   * exitosa con los conteos de nodos y aristas.
   *
   * Efectos secundarios: crea una corrida de build, realiza múltiples upserts de
   * nodos y aristas y actualiza el estado de la corrida (SUCCESS o FAILED).
   *
   * @param input - Tenant objetivo y, opcionalmente, el usuario que dispara el backfill.
   * @returns El identificador de la corrida junto con el número de nodos y aristas creados.
   * @throws Propaga cualquier error ocurrido durante el proceso tras marcar la
   *   corrida como FAILED con el mensaje de error.
   */
  public async backfillTenantGraph(input: {
    readonly tenantId: string;
    readonly userId?: string;
  }): Promise<{ readonly runId: string; readonly nodeCount: number; readonly edgeCount: number }> {
    const runId = await this.repository.createContextBuildRun({
      tenantId: input.tenantId,
      runType: 'FOCUS_GRAPH_BACKFILL',
      ...(input.userId !== undefined ? { createdByUserId: input.userId } : {}),
    });

    try {
      const aggregates = await this.repository.listFocusResourcePeriodAggregates(input.tenantId);
      let nodeCount = 0;
      let edgeCount = 0;

      for (const aggregate of aggregates) {
        const providerNode = await this.repository.upsertKnowledgeNode({
          tenantId: input.tenantId,
          scope: 'LOCAL',
          nodeType: 'provider',
          dedupeKey: `provider:${aggregate.provider}`,
          externalId: aggregate.provider,
          label: aggregate.provider,
        });
        const accountNode = await this.repository.upsertKnowledgeNode({
          tenantId: input.tenantId,
          scope: 'LOCAL',
          nodeType: 'cloud_account',
          dedupeKey: `account:${aggregate.cloudAccountId}`,
          externalId: aggregate.cloudAccountId,
          label: aggregate.cloudAccountId,
          metadata: { provider: aggregate.provider },
        });
        const serviceNode = await this.repository.upsertKnowledgeNode({
          tenantId: input.tenantId,
          scope: 'LOCAL',
          nodeType: 'service',
          dedupeKey: `service:${aggregate.provider}:${aggregate.serviceName}`,
          externalId: aggregate.serviceName,
          label: aggregate.serviceName,
          metadata: { provider: aggregate.provider },
        });
        const month = aggregate.periodStart.toISOString().slice(0, 7);
        const resourceNode = await this.repository.upsertKnowledgeNode({
          tenantId: input.tenantId,
          scope: 'LOCAL',
          nodeType: 'resource_period',
          dedupeKey: `resource-period:${aggregate.resourceId}:${month}`,
          externalId: `${aggregate.resourceId}:${month}`,
          label: `${aggregate.resourceId} (${month})`,
          metadata: {
            provider: aggregate.provider,
            cloudAccountId: aggregate.cloudAccountId,
            serviceName: aggregate.serviceName,
            billedCost: aggregate.billedCost,
            consumedQuantity: aggregate.consumedQuantity,
            consumedUnit: aggregate.consumedUnit,
            currency: aggregate.currency,
          },
        });
        nodeCount += 4;

        // Aristas dirigidas que modelan la jerarquía cloud: la cuenta y el
        // servicio pertenecen al proveedor, el recurso-periodo pertenece a la
        // cuenta y usa el servicio. Cada arista lleva una dedupeKey determinista
        // para que el upsert sea idempotente entre corridas.
        const edges = [
          [accountNode, providerNode, 'BELONGS_TO', `account-provider:${aggregate.cloudAccountId}:${aggregate.provider}`],
          [serviceNode, providerNode, 'BELONGS_TO', `service-provider:${aggregate.provider}:${aggregate.serviceName}`],
          [resourceNode, accountNode, 'BELONGS_TO', `resource-account:${aggregate.resourceId}:${month}:${aggregate.cloudAccountId}`],
          [resourceNode, serviceNode, 'USES_SERVICE', `resource-service:${aggregate.resourceId}:${month}:${aggregate.serviceName}`],
        ] as const;

        for (const [sourceNodeId, targetNodeId, relationType, dedupeKey] of edges) {
          await this.repository.upsertKnowledgeEdge({
            tenantId: input.tenantId,
            scope: 'LOCAL',
            sourceNodeId,
            targetNodeId,
            relationType,
            dedupeKey,
            confidence: 0.95,
            metadata: { source: 'FOCUS_RESOURCE_PERIOD_BACKFILL' },
          });
          edgeCount += 1;
        }
      }

      await this.repository.completeContextBuildRun({
        runId,
        status: 'SUCCESS',
        metadata: { nodeCount, edgeCount },
      });

      return { runId, nodeCount, edgeCount };
    } catch (error: unknown) {
      await this.repository.completeContextBuildRun({
        runId,
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Graph backfill failed',
      });
      throw error;
    }
  }

  /**
   * Recupera un subgrafo contextual del grafo de conocimiento del tenant,
   * opcionalmente centrado en una recomendación o un recurso concretos.
   *
   * Efecto secundario: lectura del grafo a través del repositorio.
   *
   * @param input - Parámetros de consulta.
   * @param input.tenantId - Tenant propietario del grafo.
   * @param input.recommendationId - Recomendación sobre la que centrar el subgrafo (opcional).
   * @param input.resourceId - Recurso sobre el que centrar el subgrafo (opcional).
   * @param input.depth - Profundidad de expansión del subgrafo; por defecto 2.
   * @returns El contexto del grafo de conocimiento recuperado.
   */
  public async getContextualGraph(input: {
    readonly tenantId: string;
    readonly recommendationId?: string;
    readonly resourceId?: string;
    readonly depth?: number;
  }): Promise<KnowledgeGraphContext> {
    return this.repository.getKnowledgeGraph({
      tenantId: input.tenantId,
      ...(input.recommendationId !== undefined ? { recommendationId: input.recommendationId } : {}),
      ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
      depth: input.depth ?? 2,
    });
  }
}
