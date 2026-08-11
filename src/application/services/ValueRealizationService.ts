import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { IRecommendationRepository, RecommendationSavingsMeasurement } from '../../domain/interfaces/IRecommendationRepository.js';
import type {
  IValueRealizationRepository,
  ValueRealizationFilters,
  ValueRealizationDestinationSummary,
  ValueRealizationItemsPage,
  ValueRealizationSummary,
  ValueRealizationTrendPoint,
} from '../../domain/interfaces/IValueRealizationRepository.js';
import { safeErrorMessage } from '../observability/safeError.js';

export interface ValueRealizationReconciliationResult {
  readonly tenantId: string;
  readonly durationMs: number;
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

  public listDestinationSummary(input: { readonly tenantId: string; readonly period: Date; readonly currency?: string }): Promise<readonly ValueRealizationDestinationSummary[]> {
    return this.repository.listDestinationSummary(input);
  }

  public exportItems(filters: ValueRealizationFilters) {
    return this.repository.listItemsForExport({ ...filters, pageSize: Math.min(filters.pageSize ?? 10_000, 10_000) });
  }

  public async notifyMeasurement(measurement: RecommendationSavingsMeasurement): Promise<void> {
    await this.createNotifications(measurement.tenantId, [measurement]);
  }

  /**
   * Reconciliación acotada e idempotente: la unicidad de evidenceHash del
   * repositorio de mediciones evita crear filas duplicadas. No hay una cola
   * paralela ni un segundo libro contable.
   */
  public async reconcile(tenantId: string, limit = 50): Promise<ValueRealizationReconciliationResult> {
    const startedAt = Date.now();
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
          error: safeErrorMessage(error),
        }));
      }
    }

    if (changed.length > 0) await this.createNotifications(tenantId, changed);
    return { tenantId, durationMs: Date.now() - startedAt, attempted: candidates.length, created, unchanged, waitingForData, calculated, insufficientEvidence, failures };
  }

  private async createNotifications(tenantId: string, measurements: readonly RecommendationSavingsMeasurement[]): Promise<void> {
    const users = await this.outboundRepository.findTenantUsers(tenantId);
    const generatedForDate = startOfUtcDay(new Date());
    for (const measurement of measurements) {
      let createdAny = false;
      for (const user of users.filter((item) => item.status === 'ACTIVE')) {
        try {
          await this.notificationRepository.create({
            tenantId,
            userId: user.id,
            recommendationId: measurement.recommendationId,
            type: 'SAVINGS_REMINDER',
            title: notificationTitle(measurement.status),
            message: notificationMessage(measurement),
            ...(measurement.projectedMonthlySavings !== undefined
              ? { estimatedMonthlySavings: measurement.projectedMonthlySavings }
              : {}),
            currency: measurement.currency,
            periodStart: measurement.observationStart,
            periodEnd: measurement.observationEnd,
            generatedForDate,
            dedupeKey: `VALUE_REALIZATION:${measurement.id}:${measurement.status}`,
            metadata: {
              source: 'value_realization_reconciliation',
              measurementId: measurement.id,
              measurementStatus: measurement.status,
            },
          });
          createdAny = true;
        } catch (error) {
          // La restricción diaria y dedupe hacen la operación idempotente.
          // Un fallo de notificación nunca debe revertir una medición guardada.
          if (!isUniqueViolation(error)) {
            console.error(JSON.stringify({
              level: 'warn',
              event: 'value_realization_in_app_notification_failed',
              tenantId,
              userId: user.id,
              measurementId: measurement.id,
              error: safeErrorMessage(error),
            }));
          }
        }
      }
      if (createdAny && this.onMeasurementChanged !== undefined) {
        void this.onMeasurementChanged(measurement).catch((error: unknown) => {
          console.error(JSON.stringify({
            level: 'warn',
            event: 'value_realization_outbound_notification_failed',
            tenantId,
            measurementId: measurement.id,
            error: safeErrorMessage(error),
          }));
        });
      }
    }
  }
}

function notificationTitle(status: RecommendationSavingsMeasurement['status']): string {
  if (status === 'CALCULATED') return 'Ahorro listo para revisión';
  if (status === 'VERIFIED') return 'Ahorro verificado';
  if (status === 'INSUFFICIENT_EVIDENCE') return 'Evidencia insuficiente';
  if (status === 'WAITING_FOR_DATA') return 'Medición esperando datos';
  return 'Medición de ahorro actualizada';
}

function notificationMessage(measurement: RecommendationSavingsMeasurement): string {
  if (measurement.status === 'VERIFIED') return `Una persona autorizada verificó el ahorro calculado (${measurement.currency}).`;
  if (measurement.status === 'CALCULATED') return `La medición determinística de ahorro ya está disponible para revisión (${measurement.currency}).`;
  if (measurement.status === 'INSUFFICIENT_EVIDENCE') return `La ventana terminó, pero la evidencia disponible no es suficiente para verificar el resultado (${measurement.currency}).`;
  if (measurement.status === 'WAITING_FOR_DATA') return `La medición posterior a la ejecución sigue esperando datos (${measurement.currency}).`;
  return `La medición posterior a la ejecución fue actualizada (${measurement.status.toLowerCase()}).`;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
