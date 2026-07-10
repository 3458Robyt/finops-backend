import { createHash } from 'node:crypto';
import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';

/**
 * Servicio de aplicación que construye y mantiene los resúmenes de contexto
 * cacheados a partir de los agregados FOCUS por recurso y periodo. Estos
 * resúmenes son la evidencia que luego consume el Context Engine para no tener
 * que recalcular ni reenviar datos crudos de costos al modelo.
 *
 * Colaborador inyectado:
 * - {@link IAgentContextRepository}: persistencia de corridas de construcción
 *   ("context build runs") y de los resúmenes de contexto.
 *
 * Rol dentro del flujo: tarea de backfill/precómputo que alimenta la capa de
 * contexto del agente de IA con resúmenes textuales por recurso y mes.
 */
export class ContextSummaryBuilderService {
  constructor(private readonly repository: IAgentContextRepository) {}

  /**
   * Reconstruye (backfill) los resúmenes de contexto FOCUS por recurso y periodo
   * para un tenant.
   *
   * Crea una corrida de construcción, itera sobre los agregados FOCUS y, por
   * cada uno, genera un resumen textual con costo, periodo, nº de filas y
   * consumo facturado, y lo persiste mediante upsert usando una `scopeKey`
   * determinista (proveedor:cuenta:servicio:recurso:mes) y un `sourceHash` para
   * detectar cambios. Al finalizar marca la corrida como exitosa.
   *
   * Efectos secundarios: crea una corrida de build, realiza múltiples upserts de
   * resúmenes y actualiza el estado de la corrida (SUCCESS o FAILED).
   *
   * @param input - Tenant objetivo y, opcionalmente, el usuario que dispara el backfill.
   * @returns El identificador de la corrida y el número de resúmenes generados.
   * @throws Propaga cualquier error ocurrido durante el proceso tras marcar la
   *   corrida como FAILED con el mensaje de error.
   */
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
        // El hash de la fuente permite detectar si el agregado cambió respecto a
        // un resumen previo y evitar reescrituras innecesarias en el upsert.
        const sourceHash = this.hash(aggregate);
        const month = aggregate.periodStart.toISOString().slice(0, 7);
        // Clave de ámbito determinista que identifica de forma única el resumen
        // por proveedor, cuenta, servicio, recurso y mes.
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

  /**
   * Calcula un hash SHA-256 estable de un valor serializado a JSON. Se usa como
   * huella ("sourceHash") del agregado para detectar cambios entre corridas.
   */
  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
