import type {
  CreateInAppNotificationInput,
  INotificationRepository,
  ListNotificationsQuery,
} from '../../domain/interfaces/INotificationRepository.js';
import type {
  InAppNotification,
  InAppNotificationStatus,
} from '../../domain/models/InAppNotification.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link INotificationRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: gestión de las notificaciones in-app (tabla
 * `in_app_notifications`) por usuario dentro de un tenant. Todas las operaciones
 * filtran por `tenantId` y `userId` para garantizar el aislamiento multi-tenant
 * y que un usuario solo acceda a sus propias notificaciones.
 */
export class PrismaNotificationRepository implements INotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Lista las notificaciones de un usuario dentro de su tenant, ordenadas por
   * fecha de creación descendente (más recientes primero).
   *
   * Por defecto excluye las notificaciones con estado `DISMISSED`; estas solo se
   * incluyen cuando `includeDismissed` es `true`. El número de resultados se
   * limita a `limit` (20 por defecto).
   *
   * @param query Filtros de consulta (tenant, usuario, inclusión de descartadas
   *   y límite).
   * @returns Lista de notificaciones de dominio; arreglo vacío si no hay
   *   coincidencias.
   */
  public async findByUser(query: ListNotificationsQuery): Promise<InAppNotification[]> {
    const rows = await this.prisma.inAppNotification.findMany({
      where: {
        tenantId: query.tenantId,
        userId: query.userId,
        ...(query.includeDismissed === true ? {} : { status: { not: 'DISMISSED' } }),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 20,
    });

    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Crea una nueva notificación in-app para un usuario.
   *
   * Los campos monetarios opcionales (`missedSavingsAmount`,
   * `estimatedMonthlySavings`) se expresan en la divisa indicada por `currency`.
   * Los campos opcionales solo se incluyen en la inserción cuando están
   * definidos; `metadata` se serializa como JSON de Prisma.
   *
   * @param input Datos de la notificación a crear.
   * @returns La notificación creada en formato de dominio.
   */
  public async create(input: CreateInAppNotificationInput): Promise<InAppNotification> {
    const row = await this.prisma.inAppNotification.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        ...(input.recommendationId !== undefined ? { recommendationId: input.recommendationId } : {}),
        type: input.type,
        title: input.title,
        message: input.message,
        ...(input.missedSavingsAmount !== undefined ? { missedSavingsAmount: input.missedSavingsAmount } : {}),
        ...(input.estimatedMonthlySavings !== undefined ? { estimatedMonthlySavings: input.estimatedMonthlySavings } : {}),
        currency: input.currency,
        ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
        ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
        ...(input.generatedForDate !== undefined ? { generatedForDate: input.generatedForDate } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return this.toDomain(row);
  }

  /**
   * Actualiza el estado de una notificación (p. ej. marcar como leída o
   * descartada), validando previamente la pertenencia al tenant y al usuario.
   *
   * Usa `updateMany` con filtro por `id`, `tenantId` y `userId` para impedir que
   * un usuario modifique notificaciones ajenas (aislamiento multi-tenant). Tras
   * actualizar, vuelve a leer la fila para devolver el estado resultante.
   *
   * @param tenantId Tenant propietario de la notificación.
   * @param userId Usuario propietario de la notificación.
   * @param notificationId Identificador de la notificación a actualizar.
   * @param status Nuevo estado a aplicar.
   * @returns La notificación actualizada, o `null` si no existe o no pertenece
   *   al usuario/tenant indicados.
   */
  public async updateStatus(
    tenantId: string,
    userId: string,
    notificationId: string,
    status: InAppNotificationStatus,
  ): Promise<InAppNotification | null> {
    await this.prisma.inAppNotification.updateMany({
      where: {
        id: notificationId,
        tenantId,
        userId,
      },
      data: { status },
    });

    const row = await this.prisma.inAppNotification.findFirst({
      where: {
        id: notificationId,
        tenantId,
        userId,
      },
    });

    return row === null ? null : this.toDomain(row);
  }

  /**
   * Cuenta las notificaciones sin leer (estado `UNREAD`) de un usuario en su
   * tenant. Útil para mostrar el badge de notificaciones pendientes.
   *
   * @param tenantId Tenant del usuario.
   * @param userId Usuario para el que se cuenta.
   * @returns Número de notificaciones no leídas (0 si no hay ninguna).
   */
  public async countUnread(tenantId: string, userId: string): Promise<number> {
    return this.prisma.inAppNotification.count({
      where: {
        tenantId,
        userId,
        status: 'UNREAD',
      },
    });
  }

  /**
   * Mapea una fila de Prisma (`in_app_notifications`) al modelo de dominio
   * {@link InAppNotification}.
   *
   * Casos borde manejados:
   * - Importes `Decimal` de Prisma (`missedSavingsAmount`,
   *   `estimatedMonthlySavings`) se convierten a `number` mediante `Number()`.
   * - Los campos anulables (`recommendationId`, periodos, fechas, `metadata`)
   *   solo se incluyen cuando no son `null`.
   * - Marca `persisted: true` para indicar que la entidad proviene de la base de
   *   datos.
   *
   * @param row Fila devuelta por Prisma.
   * @returns Notificación de dominio normalizada.
   */
  private toDomain(row: Awaited<ReturnType<PrismaClient['inAppNotification']['findFirst']>> & {}): InAppNotification {
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      ...(row.recommendationId !== null ? { recommendationId: row.recommendationId } : {}),
      type: row.type,
      status: row.status,
      title: row.title,
      message: row.message,
      ...(row.missedSavingsAmount !== null ? { missedSavingsAmount: Number(row.missedSavingsAmount) } : {}),
      ...(row.estimatedMonthlySavings !== null ? { estimatedMonthlySavings: Number(row.estimatedMonthlySavings) } : {}),
      currency: row.currency,
      ...(row.periodStart !== null ? { periodStart: row.periodStart } : {}),
      ...(row.periodEnd !== null ? { periodEnd: row.periodEnd } : {}),
      ...(row.generatedForDate !== null ? { generatedForDate: row.generatedForDate } : {}),
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
      persisted: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
