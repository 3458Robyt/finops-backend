import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { IRecommendationRepository, RecommendationSavingsMeasurement } from '../../domain/interfaces/IRecommendationRepository.js';
import type {
  IValueRealizationRepository,
  ValueRealizationFilters,
  ValueRealizationItemsPage,
  ValueRealizationSummary,
  ValueRealizationTrendPoint,
} from '../../domain/interfaces/IValueRealizationRepository.js';

export interface ValueRealizationReconciliationResult {
  readonly tenantId: string;
  readonly attempted: number;
  readonly created: number;
  readonly unchanged: number;
  readonly waitingForData: number;
  readonly calculated: number;
  readonly insufficientEvidence: number;
  readonly failures: number;
}

export class ValueRealizationService {
  constructor(
    private readonly repository: IValueRealizationRepository,
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly notificationRepository: INotificationRepository,
    private readonly outboundRepository: IOutboundMessageRepository,
    private readonly onMeasurementChanged: ((measurement: RecommendationSavingsMeasurement) => Promise<void>) | undefined = undefined,
  ) {}

  public getSummary(filters: ValueRealizationFilters): Promise<ValueRealizationSummary> {
    return this.repository.getSummary(filters);
  }

  public listItems(filters: ValueRealizationFilters): Promise<ValueRealizationItemsPage> {
    return this.repository.listItems(filters);
  }

  public listTrend(filters: ValueRealizationFilters): Promise<readonly ValueRealizationTrendPoint[]> {
    return this.repository.listTrend(filters);
  }

  public exportItems(filters: ValueRealizationFilters) {
    return this.repository.listItemsForExport({ ...filters, pageSize: Math.min(filters.pageSize ?? 10_000, 10_000) });
  }

  /**
   * Reconciliación acotada e idempotente: la unicidad de evidenceHash del
   * repositorio de mediciones evita crear filas duplicadas. No hay una cola
   * paralela ni un segundo libro contable.
   */
  public async reconcile(tenantId: string, limit = 50): Promise<ValueRealizationReconciliationResult> {
    const candidates = await this.repository.listReconciliationCandidates({ tenantId, limit });
    let created = 0;
    let unchanged = 0;
    let waitingForData = 0;
    let calculated = 0;
    let insufficientEvidence = 0;
    let failures = 0;
    const changed: RecommendationSavingsMeasurement[] = [];

    for (const candidate of candidates) {
      try {
        const measurement = await this.recommendationRepository.createSavingsMeasurement({
          tenantId,
          recommendationId: candidate.recommendationId,
          manualExecutionId: candidate.manualExecutionId,
          requestedByUserId: candidate.requestedByUserId,
          windowDays: 30,
        });
        if (measurement.id === candidate.latestMeasurementId) unchanged += 1;
        else {
          created += 1;
          changed.push(measurement);
        }
        if (measurement.status === 'WAITING_FOR_DATA') waitingForData += 1;
        if (measurement.status === 'CALCULATED') calculated += 1;
        if (measurement.status === 'INSUFFICIENT_EVIDENCE') insufficientEvidence += 1;
      } catch (error) {
        failures += 1;
        console.error(JSON.stringify({
          level: 'warn',
          event: 'value_realization_reconciliation_failed',
          tenantId,
          recommendationId: candidate.recommendationId,
          manualExecutionId: candidate.manualExecutionId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    if (changed.length > 0) await this.createNotifications(tenantId, changed);
    return { tenantId, attempted: candidates.length, created, unchanged, waitingForData, calculated, insufficientEvidence, failures };
  }

  private async createNotifications(tenantId: string, measurements: readonly RecommendationSavingsMeasurement[]): Promise<void> {
    const users = await this.outboundRepository.findTenantUsers(tenantId);
    const generatedForDate = startOfUtcDay(new Date());
    for (const measurement of measurements) {
      if (this.onMeasurementChanged !== undefined) {
        void this.onMeasurementChanged(measurement).catch((error: unknown) => {
          console.error(JSON.stringify({
            level: 'warn',
            event: 'value_realization_outbound_notification_failed',
            tenantId,
            measurementId: measurement.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      }
      for (const user of users.filter((item) => item.status === 'ACTIVE')) {
        try {
          await this.notificationRepository.create({
            tenantId,
            userId: user.id,
            recommendationId: measurement.recommendationId,
            type: 'SAVINGS_REMINDER',
            title: measurement.status === 'CALCULATED' ? 'Ahorro listo para revisión' : 'Medición de ahorro actualizada',
            message: measurement.status === 'CALCULATED'
              ? `La medición determinística de ahorro ya está disponible para revisión (${measurement.currency}).`
              : `La medición posterior a la ejecución fue actualizada (${measurement.status.toLowerCase()}).`,
            ...(measurement.projectedMonthlySavings !== undefined
              ? { estimatedMonthlySavings: measurement.projectedMonthlySavings }
              : {}),
            currency: measurement.currency,
            periodStart: measurement.observationStart,
            periodEnd: measurement.observationEnd,
            generatedForDate,
            metadata: {
              source: 'value_realization_reconciliation',
              measurementId: measurement.id,
              measurementStatus: measurement.status,
            },
          });
        } catch (error) {
          // La restricción diaria existente hace la operación idempotente.
          if (!isUniqueViolation(error)) throw error;
        }
      }
    }
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
