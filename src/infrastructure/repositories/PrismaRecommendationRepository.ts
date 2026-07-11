import type {
  CreateRecommendationDecisionInput,
  CreateRecommendationDecisionResult,
  CreateRecommendationExecutionPlanInput,
  CreateRecommendationInput,
  CreateManualExecutionInput,
  AdoptionKpis,
  IRecommendationRepository,
  RecommendationManualExecution,
  RecommendationQuery,
  RecommendationTimelineEvent,
  SavingsKpis,
} from '../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type { RecommendationExecutionPlan } from '../../domain/models/RecommendationExecutionPlan.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  toDomain,
  toExecutionPlanDomain,
  toManualExecutionDomain,
} from './mappers/recommendationMappers.js';
import {
  computeAdoptionKpis,
  computeSavingsKpis,
} from './queries/recommendationKpiQueries.js';
import { buildRecommendationTimeline } from './queries/recommendationTimelineBuilder.js';
import {
  createDecisionTx,
  createManualExecutionTx,
} from './queries/recommendationWriteQueries.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link IRecommendationRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: persistencia y consulta del ciclo de vida de las
 * recomendaciones FinOps y sus entidades relacionadas: planes de ejecución
 * auditados (`recommendation_execution_plans`), decisiones humanas
 * (`recommendation_decisions`), ejecuciones manuales
 * (`recommendation_manual_executions`) y los KPIs de ahorro y adopción. Todas
 * las consultas filtran por `tenantId` (a veces a través de la relación con
 * `recommendation`) para garantizar el aislamiento multi-tenant.
 */
export class PrismaRecommendationRepository implements IRecommendationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Busca una recomendación por su id dentro de un tenant.
   *
   * El filtro combinado `id` + `tenantId` garantiza el aislamiento multi-tenant.
   *
   * @param tenantId Tenant propietario de la recomendación.
   * @param recommendationId Identificador de la recomendación.
   * @returns La recomendación de dominio, o `null` si no existe o no pertenece
   *   al tenant.
   */
  public async findById(tenantId: string, recommendationId: string): Promise<FinOpsRecommendation | null> {
    const row = await this.prisma.recommendation.findFirst({
      where: {
        id: recommendationId,
        tenantId,
      },
    });

    return row === null ? null : toDomain(row);
  }

  /**
   * Lista las recomendaciones de un tenant, con filtros opcionales por cuenta
   * cloud y estado.
   *
   * Filtra por `tenantId` (aislamiento multi-tenant) y ordena por fecha de
   * creación descendente.
   *
   * @param query Criterios de consulta (tenant y filtros opcionales).
   * @returns Lista de recomendaciones de dominio; arreglo vacío si no hay
   *   coincidencias.
   */
  public async findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: {
        tenantId: query.tenantId,
        ...(query.cloudAccountId !== undefined ? { cloudAccountId: query.cloudAccountId } : {}),
        ...(query.externalResourceId !== undefined
          ? { evidence: { path: ['externalResourceId'], equals: query.externalResourceId } }
          : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      orderBy: [
        { createdAt: 'desc' },
      ],
    });

    return rows.map((row) => toDomain(row));
  }

  /**
   * Crea múltiples recomendaciones, una por cada entrada del lote.
   *
   * Cada recomendación se inicializa con estado `PENDING`. Cuando recibe una
   * huella de deduplicación, reutiliza el registro existente del mismo tenant;
   * de este modo dos generaciones equivalentes no duplican oportunidades. El
   * campo `evidence` se serializa como JSON de Prisma y `estimatedMonthlySavings`
   * solo se incluye cuando está definido.
   *
   * @param input Lote de recomendaciones a crear.
   * @returns Las recomendaciones creadas en formato de dominio; arreglo vacío si
   *   el lote viene vacío.
   */
  public async createMany(input: readonly CreateRecommendationInput[]): Promise<FinOpsRecommendation[]> {
    if (input.length === 0) {
      return [];
    }

    const rows = await Promise.all(input.map((item) => {
      const data = {
        tenantId: item.tenantId,
        cloudAccountId: item.cloudAccountId,
        type: item.type,
        severity: item.severity,
        status: 'PENDING' as const,
        title: item.title,
        description: item.description,
        evidence: item.evidence as Prisma.InputJsonValue,
        ...(item.deduplicationKey !== undefined ? { deduplicationKey: item.deduplicationKey } : {}),
        ...(item.estimatedMonthlySavings !== undefined
          ? { estimatedMonthlySavings: item.estimatedMonthlySavings }
          : {}),
        currency: item.currency,
      };

      return item.deduplicationKey === undefined
        ? this.prisma.recommendation.create({ data })
        : this.prisma.recommendation.upsert({
          where: {
            tenantId_deduplicationKey: {
              tenantId: item.tenantId,
              deduplicationKey: item.deduplicationKey,
            },
          },
          create: data,
          update: {},
        });
    }));

    return rows.map((row) => toDomain(row));
  }

  /**
   * Crea un plan de ejecución auditado para una recomendación.
   *
   * Persiste tanto el contenido del plan como el reporte de auditoría IA
   * (`content` y `auditReport` se serializan como JSON), junto con el veredicto y
   * la puntuación del auditor.
   *
   * @param input Datos del plan (recomendación, autor, modelos, contenido y
   *   resultado de auditoría).
   * @returns El plan de ejecución creado en formato de dominio.
   */
  public async createExecutionPlan(
    input: CreateRecommendationExecutionPlanInput,
  ): Promise<RecommendationExecutionPlan> {
    const row = await this.prisma.recommendationExecutionPlan.create({
      data: {
        recommendationId: input.recommendationId,
        generatedByUserId: input.generatedByUserId,
        model: input.model,
        auditorModel: input.auditorModel,
        content: input.content as Prisma.InputJsonValue,
        auditReport: input.auditReport as unknown as Prisma.InputJsonValue,
        auditVerdict: input.auditVerdict,
        auditScore: input.auditScore,
      },
    });

    return toExecutionPlanDomain(row);
  }

  /**
   * Busca un plan de ejecución por su id, validando que la recomendación
   * asociada pertenezca al tenant.
   *
   * El aislamiento multi-tenant se aplica filtrando por la relación
   * `recommendation.tenantId`.
   *
   * @param tenantId Tenant propietario de la recomendación asociada.
   * @param executionPlanId Identificador del plan de ejecución.
   * @returns El plan de dominio, o `null` si no existe o no pertenece al tenant.
   */
  public async findExecutionPlanById(
    tenantId: string,
    executionPlanId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    const row = await this.prisma.recommendationExecutionPlan.findFirst({
      where: {
        id: executionPlanId,
        recommendation: {
          tenantId,
        },
      },
    });

    return row === null ? null : toExecutionPlanDomain(row);
  }

  /**
   * Obtiene el último plan aprobado por auditoría de una recomendación dentro
   * de un tenant. Los planes rechazados nunca se reutilizan ni se exponen como
   * plan operativo.
   *
   * Filtra por recomendación y por la relación `recommendation.tenantId`
   * (aislamiento multi-tenant), ordenando por fecha de creación descendente.
   *
   * @param tenantId Tenant propietario de la recomendación.
   * @param recommendationId Identificador de la recomendación.
   * @returns El plan más reciente de dominio, o `null` si no hay planes.
   */
  public async findLatestExecutionPlanByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    const row = await this.prisma.recommendationExecutionPlan.findFirst({
      where: {
        recommendationId,
        recommendation: {
          tenantId,
        },
        auditVerdict: 'APPROVED',
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return row === null ? null : toExecutionPlanDomain(row);
  }

  /**
   * Registra una decisión humana (aprobar/rechazar/marcar como hecha) sobre una
   * recomendación y sincroniza el estado de la recomendación, todo de forma
   * atómica.
   *
   * Dentro de una transacción: (1) verifica que la recomendación exista en el
   * tenant (aislamiento multi-tenant), lanzando error si no; (2) crea la decisión
   * con `learningStatus: 'PENDING'` (el aprendizaje del agente se procesa
   * después); y (3) actualiza el estado de la recomendación, mapeando
   * `MARKED_DONE` a `MANUAL_COMPLETED` y, en el resto de casos, usando el propio
   * valor de la decisión.
   *
   * @param input Datos de la decisión (tenant, recomendación, usuario, decisión
   *   y motivo opcional).
   * @returns El id de la decisión creada y la recomendación actualizada en
   *   formato de dominio.
   * @throws Error si la recomendación no existe en el tenant.
   */
  public async createDecision(
    input: CreateRecommendationDecisionInput,
  ): Promise<CreateRecommendationDecisionResult> {
    const result = await createDecisionTx(this.prisma, input);

    return {
      decisionId: result.decisionId,
      recommendation: toDomain(result.recommendation),
    };
  }

  /**
   * Registra una ejecución manual de una recomendación y, si procede, actualiza
   * el estado de la recomendación, de forma atómica.
   *
   * Dentro de una transacción valida invariantes de negocio: (1) la recomendación
   * debe existir en el tenant (aislamiento multi-tenant); (2) solo se pueden
   * ejecutar manualmente recomendaciones en estado `APPROVED` o
   * `MANUAL_COMPLETED`; (3) si se indica `executionPlanId`, este debe pertenecer
   * a la recomendación. Crea el registro de ejecución (importe observado en la
   * divisa `currency`, `evidence` como JSON) y, cuando el estado es `EXECUTED`,
   * marca la recomendación como `MANUAL_COMPLETED`.
   *
   * @param input Datos de la ejecución manual.
   * @returns La ejecución manual creada en formato de dominio.
   * @throws Error si la recomendación no existe, no está en un estado válido o
   *   el plan de ejecución indicado no corresponde a la recomendación.
   */
  public async createManualExecution(
    input: CreateManualExecutionInput,
  ): Promise<RecommendationManualExecution> {
    const result = await createManualExecutionTx(this.prisma, input);

    return toManualExecutionDomain(result);
  }

  /**
   * Lista las ejecuciones manuales de una recomendación dentro de un tenant,
   * de la más reciente a la más antigua.
   *
   * @param tenantId Tenant propietario (aislamiento multi-tenant).
   * @param recommendationId Recomendación cuyas ejecuciones se listan.
   * @returns Lista de ejecuciones manuales de dominio; arreglo vacío si no hay.
   */
  public async findManualExecutionsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationManualExecution[]> {
    const rows = await this.prisma.recommendationManualExecution.findMany({
      where: {
        tenantId,
        recommendationId,
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => toManualExecutionDomain(row));
  }

  /**
   * Construye una línea de tiempo unificada y cronológica de todos los eventos
   * de una recomendación.
   *
   * Verifica primero que la recomendación pertenezca al tenant (aislamiento
   * multi-tenant); si no, devuelve un arreglo vacío. Luego carga en paralelo los
   * planes de ejecución, decisiones, ejecuciones manuales y eventos de
   * aprendizaje del agente, y los combina en eventos homogéneos
   * {@link RecommendationTimelineEvent} (incluyendo el evento sintético de
   * creación de la recomendación). Finalmente ordena todos los eventos por
   * `createdAt` ascendente.
   *
   * @param tenantId Tenant propietario de la recomendación.
   * @param recommendationId Recomendación cuya línea de tiempo se construye.
   * @returns Eventos ordenados cronológicamente; arreglo vacío si la
   *   recomendación no existe o no pertenece al tenant.
   */
  public async findTimelineByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationTimelineEvent[]> {
    const recommendation = await this.prisma.recommendation.findFirst({
      where: { tenantId, id: recommendationId },
    });

    if (recommendation === null) {
      return [];
    }

    const [plans, decisions, executions, learningEvents] = await Promise.all([
      this.prisma.recommendationExecutionPlan.findMany({
        where: { recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.recommendationDecision.findMany({
        where: { recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.recommendationManualExecution.findMany({
        where: { tenantId, recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.agentLearningEvent.findMany({
        where: { tenantId, recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return buildRecommendationTimeline(recommendation, plans, decisions, executions, learningEvents);
  }

  /**
   * Calcula los KPIs de ahorro de un tenant (ahorro estimado, observado,
   * confirmado y ahorro perdido por inacción).
   *
   * Ejecuta en paralelo: (1) suma del ahorro mensual estimado de todas las
   * recomendaciones; (2) suma del ahorro mensual observado en ejecuciones
   * `EXECUTED`/`PARTIAL`; (3) recuento de recomendaciones distintas efectivamente
   * ejecutadas (groupBy); y (4) recomendaciones pendientes/aprobadas con ahorro
   * estimado positivo. Sobre estas últimas calcula el "ahorro perdido"
   * (proporcional al tiempo transcurrido sin ejecutar, ver
   * {@link calculateMissedSavings}), filtrando importes despreciables (< 0.01),
   * acumulando el total redondeado y destacando la recomendación con mayor ahorro
   * perdido. La divisa de los KPIs se fija a `USD`.
   *
   * @param tenantId Tenant del que se calculan los KPIs (aislamiento
   *   multi-tenant).
   * @returns KPIs de ahorro de dominio.
   */
  public async getSavingsKpis(tenantId: string): Promise<SavingsKpis> {
    return computeSavingsKpis(this.prisma, tenantId);
  }

  /**
   * Calcula los KPIs de adopción de un tenant (totales por estado y tasas de
   * aceptación, rechazo y ejecución).
   *
   * Agrupa las recomendaciones por estado (`groupBy`) y deriva los conteos. Las
   * tasas se calculan de forma defensiva sobre el conjunto de recomendaciones ya
   * "decididas" (aprobadas + rechazadas + completadas), devolviendo 0 cuando el
   * denominador es 0 para evitar divisiones por cero:
   * - `acceptanceRate`: (aprobadas + completadas) / decididas.
   * - `rejectionRate`: rechazadas / decididas.
   * - `executionRate`: completadas / total de recomendaciones.
   *
   * @param tenantId Tenant del que se calculan los KPIs (aislamiento
   *   multi-tenant).
   * @returns KPIs de adopción de dominio.
   */
  public async getAdoptionKpis(tenantId: string): Promise<AdoptionKpis> {
    return computeAdoptionKpis(this.prisma, tenantId);
  }
}
