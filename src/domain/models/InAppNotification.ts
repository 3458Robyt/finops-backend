/**
 * Tipo de notificación interna mostrada dentro de la aplicación.
 *
 * - `SAVINGS_REMINDER`: Recordatorio sobre ahorros potenciales o no aprovechados.
 */
export type InAppNotificationType = 'SAVINGS_REMINDER';

/**
 * Estado de lectura/gestión de una notificación interna.
 *
 * - `UNREAD`: Sin leer.
 * - `READ`: Leída por el usuario.
 * - `DISMISSED`: Descartada por el usuario.
 */
export type InAppNotificationStatus = 'UNREAD' | 'READ' | 'DISMISSED';

/**
 * Notificación interna (in-app) dirigida a un usuario de un tenant. Se utiliza,
 * por ejemplo, para recordar ahorros no aprovechados derivados de recomendaciones.
 */
export interface InAppNotification {
  /** Identificador único de la notificación. */
  readonly id: string;
  /** Tenant (cliente) al que pertenece la notificación. */
  readonly tenantId: string;
  /** Usuario destinatario de la notificación. */
  readonly userId: string;
  /** Recomendación relacionada con la notificación, si aplica. */
  readonly recommendationId?: string;
  /** Tipo de notificación. */
  readonly type: InAppNotificationType;
  /** Estado de lectura/gestión de la notificación. */
  readonly status: InAppNotificationStatus;
  /** Título de la notificación. */
  readonly title: string;
  /** Cuerpo del mensaje de la notificación. */
  readonly message: string;
  /** Importe de ahorro no aprovechado, expresado en {@link currency}. */
  readonly missedSavingsAmount?: number;
  /** Ahorro mensual estimado asociado, expresado en {@link currency}. */
  readonly estimatedMonthlySavings?: number;
  /** Divisa de los importes, en formato ISO 4217 de 3 letras (e.g., "USD"). */
  readonly currency: string;
  /** Inicio del periodo al que se refieren los importes. */
  readonly periodStart?: Date;
  /** Fin del periodo al que se refieren los importes. */
  readonly periodEnd?: Date;
  /** Fecha para la que se generó la notificación (e.g., día de cálculo). */
  readonly generatedForDate?: Date;
  /** Metadatos adicionales de la notificación (estructura libre). */
  readonly metadata?: unknown;
  /** `true` si la notificación se ha persistido en almacenamiento. */
  readonly persisted: boolean;
  /** Fecha de creación del registro. */
  readonly createdAt: Date;
  /** Fecha de la última actualización del registro. */
  readonly updatedAt: Date;
}
