import { createHash } from 'node:crypto';
import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';

export class ContextSummaryBuilderService {
  constructor(private readonly repository: IAgentContextRepository) {}

  public async backfillTenantContext(input: {
    readonly tenantId: string;
    readonly userId?: string;
  }): Promise<{ readonly runId: string; readonly summaryCount: number }> {
    const runId = await this.repository.createContextBuildRun({
      tenantId: input.tenantId,
      runType: 'FOCUS_RESOURCE_PERIOD_BACKFILL',
      ...(input.userId !== undefined ? { createdByUserId: input.userId } : {}),
    });

    try {
      const aggregates = await this.repository.listFocusResourcePeriodAggregates(input.tenantId);
      let summaryCount = 0;

      for (const aggregate of aggregates) {
        const sourceHash = this.hash(aggregate);
        const month = aggregate.periodStart.toISOString().slice(0, 7);
        const scopeKey = [
          aggregate.provider,
          aggregate.cloudAccountId,
          aggregate.serviceName,
          aggregate.resourceId,
          month,
        ].join(':');
        const consumed = aggregate.consumedQuantity !== undefined && aggregate.consumedUnit !== undefined
          ? ` Consumo facturado ${aggregate.consumedQuantity.toFixed(4)} ${aggregate.consumedUnit}.`
          : ' Sin consumo facturado homogeneo disponible.';
        const summary = [
          `Recurso ${aggregate.resourceId} en ${aggregate.serviceName}/${aggregate.provider}.`,
          `Periodo ${month}. Costo ${aggregate.billedCost.toFixed(2)} ${aggregate.currency}.`,
          `Filas FOCUS agregadas: ${aggregate.metricCount}.`,
          consumed,
        ].join(' ');

        await this.repository.upsertContextSummary({
          tenantId: input.tenantId,
          artifactType: 'FOCUS_RESOURCE_PERIOD',
          scopeKey,
          provider: aggregate.provider,
          cloudAccountId: aggregate.cloudAccountId,
          serviceName: aggregate.serviceName,
          resourceId: aggregate.resourceId,
          periodStart: aggregate.periodStart,
          periodEnd: aggregate.periodEnd,
          sourceHash,
          summary,
          tokenEstimate: Math.ceil(summary.length / 4),
          facts: aggregate,
          evidenceRefs: {
            source: 'cost_metrics',
            resourceId: aggregate.resourceId,
            periodStart: aggregate.periodStart.toISOString(),
            periodEnd: aggregate.periodEnd.toISOString(),
          },
        });
        summaryCount += 1;
      }

      await this.repository.completeContextBuildRun({
        runId,
        status: 'SUCCESS',
        metadata: { summaryCount },
      });

      return { runId, summaryCount };
    } catch (error: unknown) {
      await this.repository.completeContextBuildRun({
        runId,
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Context backfill failed',
      });
      throw error;
    }
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
