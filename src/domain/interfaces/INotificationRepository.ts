import type {
  InAppNotification,
  InAppNotificationStatus,
  InAppNotificationType,
} from '../models/InAppNotification.js';

/**
 * Criterios de consulta para listar notificaciones in-app de un usuario.
 */
export interface ListNotificationsQuery {
  readonly tenantId: string;
  readonly userId: string;
  /** Si es `true`, incluye también las notificaciones descartadas; por defecto se omiten. */
  readonly includeDismissed?: boolean;
  /** Límite máximo de notificaciones a devolver; opcional. */
  readonly limit?: number;
}

/**
 * Datos de entrada para crear una notificación in-app.
 *
 * Muchas notificaciones se asocian a oportunidades de ahorro detectadas, por lo
 * que incluyen importes y periodos de referencia opcionales.
 */
export interface CreateInAppNotificationInput {
  readonly tenantId: string;
  readonly userId: string;
  /** Recomendación que origina la notificación; opcional. */
  readonly recommendationId?: string;
  /** Tipo/categoría de la notificación. */
  readonly type: InAppNotificationType;
  readonly title: string;
  readonly message: string;
  /** Ahorro perdido asociado, en la moneda indicada; opcional. */
  readonly missedSavingsAmount?: number;
  /** Ahorro mensual estimado asociado, en la moneda indicada; opcional. */
  readonly estimatedMonthlySavings?: number;
  /** Código de moneda (e.g., "USD") de los importes. */
  readonly currency: string;
  /** Inicio del periodo de referencia de la notificación; opcional. */
  readonly periodStart?: Date;
  /** Fin del periodo de referencia de la notificación; opcional. */
  readonly periodEnd?: Date;
  /** Fecha para la que se generó la notificación; opcional. */
  readonly generatedForDate?: Date;
  /** Metadatos adicionales arbitrarios; opcional. */
  readonly metadata?: unknown;
}

/**
 * Contrato de repositorio de notificaciones in-app.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Gestiona la creación, consulta y cambio de estado de las
 * notificaciones mostradas dentro de la aplicación.
 */
export interface INotificationRepository {
  /**
   * Lista las notificaciones de un usuario según los criterios indicados.
   *
   * @param query - Tenant, usuario y filtros de listado.
   * @returns Notificaciones que cumplen los criterios (posiblemente vacío).
   */
  findByUser(query: ListNotificationsQuery): Promise<InAppNotification[]>;

  /**
   * Crea una nueva notificación in-app.
   *
   * @param input - Datos de la notificación a crear.
   * @returns La notificación creada.
   */
  create(input: CreateInAppNotificationInput): Promise<InAppNotification>;

  /**
   * Actualiza el estado de una notificación de un usuario (e.g., leída, descartada).
   *
   * @param tenantId       - Tenant propietario de la notificación.
   * @param userId         - Usuario destinatario de la notificación.
   * @param notificationId - Identificador de la notificación.
   * @param status         - Nuevo estado a aplicar.
   * @returns La notificación actualizada; `null` si no existe o no pertenece al usuario/tenant.
   */
  updateStatus(
    tenantId: string,
    userId: string,
    notificationId: string,
    status: InAppNotificationStatus,
  ): Promise<InAppNotification | null>;

  /**
   * Cuenta las notificaciones no leídas de un usuario.
   *
   * @param tenantId - Tenant propietario.
   * @param userId   - Usuario destinatario.
   * @returns Número de notificaciones no leídas.
   */
  countUnread(tenantId: string, userId: string): Promise<number>;
}
