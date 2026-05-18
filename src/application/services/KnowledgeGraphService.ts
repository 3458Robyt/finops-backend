import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type { KnowledgeGraphContext } from '../../domain/models/AgentContext.js';

export class KnowledgeGraphService {
  constructor(private readonly repository: IAgentContextRepository) {}

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
