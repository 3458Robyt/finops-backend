import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { InAppNotification } from '../../domain/models/InAppNotification.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';

/** Parámetros de consulta para obtener los recordatorios de ahorro de un usuario. */
export interface SavingsReminderQuery {
  readonly tenantId: string;
  readonly userId: string;
  /** Instante de referencia para los cálculos; por defecto el momento actual. Útil para pruebas deterministas. */
  readonly now?: Date;
}

/** Resultado de la consulta de recordatorios de ahorro para un usuario. */
export interface SavingsReminderResult {
  /** Notificaciones combinadas (previews calculadas + persistidas), limitadas a 20. */
  readonly notifications: readonly InAppNotification[];
  /** Total de no leídas: persistidas no leídas más las previews calculadas. */
  readonly unreadCount: number;
  /** Número de previews calculadas en caliente (no persistidas) incluidas. */
  readonly previewCount: number;
}

/** Milisegundos en un día, usado para calcular días transcurridos. */
const millisecondsPerDay = 24 * 60 * 60 * 1000;

/**
 * Servicio de aplicación que genera recordatorios de ahorro no capturado para
 * los usuarios. Combina notificaciones persistidas con "previews" calculadas en
 * caliente a partir de las recomendaciones activas, estimando cuánto ahorro se
 * ha perdido desde que se generó cada recomendación.
 *
 * Colaboradores inyectados:
 * - {@link IRecommendationRepository}: fuente de recomendaciones del tenant.
 * - {@link INotificationRepository}: notificaciones persistidas y conteo de no leídas.
 *
 * Rol dentro del flujo: alimenta tanto la bandeja de notificaciones in-app como
 * el comando de recordatorios del bot de Telegram.
 */
export class SavingsReminderService {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly notificationRepository: INotificationRepository,
  ) {}

  /**
   * Obtiene las notificaciones de ahorro de un usuario, mezclando previews
   * calculadas con notificaciones persistidas.
   *
   * Recupera en paralelo las notificaciones persistidas, el conteo de no leídas
   * y las recomendaciones del tenant; construye las previews de ahorro no
   * capturado y antepone estas a las persistidas, limitando el total a 20. El
   * conteo de no leídas suma las previews calculadas (que no están persistidas).
   *
   * Efecto secundario: lecturas a través de los repositorios (no persiste nada).
   *
   * @param query - Tenant, usuario e instante de referencia opcional.
   * @returns Las notificaciones combinadas, el total de no leídas y el número de previews.
   */
  public async getNotificationsForUser(query: SavingsReminderQuery): Promise<SavingsReminderResult> {
    const now = query.now ?? new Date();
    const [persistedNotifications, unreadCount, recommendations] = await Promise.all([
      this.notificationRepository.findByUser({
        tenantId: query.tenantId,
        userId: query.userId,
        limit: 20,
      }),
      this.notificationRepository.countUnread(query.tenantId, query.userId),
      this.recommendationRepository.findByTenant({ tenantId: query.tenantId }),
    ]);

    const previews = this.buildSavingsReminderPreviews(query.tenantId, query.userId, recommendations, now);

    return {
      notifications: [...previews, ...persistedNotifications].slice(0, 20),
      unreadCount: unreadCount + previews.length,
      previewCount: previews.length,
    };
  }

  /**
   * Marca una notificación como leída (READ).
   *
   * Efecto secundario: actualiza el estado de la notificación en el repositorio.
   *
   * @param tenantId - Tenant propietario de la notificación.
   * @param userId - Usuario propietario de la notificación.
   * @param notificationId - Identificador de la notificación a actualizar.
   * @returns La notificación actualizada, o `null` si no existe.
   */
  public async markRead(
    tenantId: string,
    userId: string,
    notificationId: string,
  ): Promise<InAppNotification | null> {
    return this.notificationRepository.updateStatus(tenantId, userId, notificationId, 'READ');
  }

  /**
   * Descarta una notificación (DISMISSED).
   *
   * Efecto secundario: actualiza el estado de la notificación en el repositorio.
   *
   * @param tenantId - Tenant propietario de la notificación.
   * @param userId - Usuario propietario de la notificación.
   * @param notificationId - Identificador de la notificación a descartar.
   * @returns La notificación actualizada, o `null` si no existe.
   */
  public async dismiss(
    tenantId: string,
    userId: string,
    notificationId: string,
  ): Promise<InAppNotification | null> {
    return this.notificationRepository.updateStatus(tenantId, userId, notificationId, 'DISMISSED');
  }

  /**
   * Construye las previews de recordatorios de ahorro a partir de las
   * recomendaciones activas.
   *
   * Solo considera recomendaciones en estado PENDING o APPROVED, convierte cada
   * una en una preview (descartando las de ahorro despreciable), las ordena de
   * mayor a menor ahorro no capturado y devuelve como máximo las 3 principales.
   */
  private buildSavingsReminderPreviews(
    tenantId: string,
    userId: string,
    recommendations: readonly FinOpsRecommendation[],
    now: Date,
  ): InAppNotification[] {
    return recommendations
      .filter((recommendation) => recommendation.status === 'PENDING' || recommendation.status === 'APPROVED')
      .map((recommendation) => this.toSavingsReminderPreview(tenantId, userId, recommendation, now))
      .filter((notification): notification is InAppNotification => notification !== null)
      .sort((left, right) => (right.missedSavingsAmount ?? 0) - (left.missedSavingsAmount ?? 0))
      .slice(0, 3);
  }

  /**
   * Convierte una recomendación en una preview de notificación de ahorro no
   * capturado, o `null` si el ahorro acumulado es despreciable.
   *
   * El ahorro perdido se estima prorrateando el ahorro mensual estimado a una
   * tarifa diaria (÷30) multiplicada por los días transcurridos desde la
   * creación de la recomendación. Si el monto resultante es menor o igual a un
   * centavo (0.01) se descarta para no generar ruido. La notificación devuelta
   * no está persistida (`persisted: false`) y usa un id con prefijo `preview-`.
   */
  private toSavingsReminderPreview(
    tenantId: string,
    userId: string,
    recommendation: FinOpsRecommendation,
    now: Date,
  ): InAppNotification | null {
    const estimatedMonthlySavings = recommendation.estimatedMonthlySavings ?? 0;
    const elapsedDays = Math.max(0, Math.floor((now.getTime() - recommendation.createdAt.getTime()) / millisecondsPerDay));
    const missedSavingsAmount = roundCurrency((estimatedMonthlySavings / 30) * elapsedDays);

    if (missedSavingsAmount <= 0.01) {
      return null;
    }

    return {
      id: `preview-${recommendation.id}`,
      tenantId,
      userId,
      recommendationId: recommendation.id,
      type: 'SAVINGS_REMINDER',
      status: 'UNREAD',
      title: 'Ahorro no capturado',
      message: `¿Sabías que podrías haberte ahorrado ${recommendation.currency} ${missedSavingsAmount.toFixed(2)} desde que se generó esta oportunidad: "${recommendation.title}"?`,
      missedSavingsAmount,
      estimatedMonthlySavings,
      currency: recommendation.currency,
      periodStart: recommendation.createdAt,
      periodEnd: now,
      generatedForDate: startOfUtcDay(now),
      metadata: {
        recommendationStatus: recommendation.status,
        source: 'calculated_preview',
      },
      persisted: false,
      createdAt: now,
      updatedAt: now,
    };
  }
}

/** Normaliza una fecha al inicio del día en UTC (00:00:00), descartando la hora. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Redondea un monto monetario a dos decimales (céntimos). */
function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
