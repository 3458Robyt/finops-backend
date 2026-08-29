import type {
  CreateRecommendationDecisionInput,
  CreateRecommendationDecisionResult,
  CreateRecommendationExecutionPlanInput,
  CreateRecommendationInput,
  CreateManualExecutionInput,
  RecommendationManualExecution,
  RecommendationQuery,
} from "../../domain/interfaces/IRecommendationRepository.js";
import type { FinOpsRecommendation } from "../../domain/models/FinOpsRecommendation.js";
import type { RecommendationExecutionPlan } from "../../domain/models/RecommendationExecutionPlan.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import {
  toDomain,
  toExecutionPlanDomain,
  toManualExecutionDomain,
} from "./mappers/recommendationMappers.js";
import {
  createDecisionTx,
  createManualExecutionTx,
} from "./queries/recommendationWriteQueries.js";

/** Persists recommendation identity, lifecycle and manual execution state. */
export class PrismaRecommendationLifecycleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findById(
    tenantId: string,
    recommendationId: string,
  ): Promise<FinOpsRecommendation | null> {
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

  public async findByTenant(
    query: RecommendationQuery,
  ): Promise<FinOpsRecommendation[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: {
        tenantId: query.tenantId,
        ...(query.cloudAccountId !== undefined
          ? { cloudAccountId: query.cloudAccountId }
          : {}),
        ...(query.externalResourceId !== undefined
          ? {
              OR: [
                {
                  cloudResource: {
                    externalResourceId: query.externalResourceId,
                  },
                },
                {
                  evidence: {
                    path: ["externalResourceId"],
                    equals: query.externalResourceId,
                  },
                },
              ],
            }
          : {}),
        ...(query.cloudResourceId !== undefined
          ? { cloudResourceId: query.cloudResourceId }
          : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: "desc" }],
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

  public async createMany(
    input: readonly CreateRecommendationInput[],
  ): Promise<FinOpsRecommendation[]> {
    if (input.length === 0) {
      return [];
    }

    const rows = await Promise.all(
      input.map((item) => {
        const data = {
          tenantId: item.tenantId,
          cloudAccountId: item.cloudAccountId,
          ...(item.cloudResourceId !== undefined
            ? { cloudResourceId: item.cloudResourceId }
            : {}),
          ...(item.resourceLinkReason !== undefined
            ? { resourceLinkReason: item.resourceLinkReason }
            : {}),
          type: item.type,
          origin: item.origin ?? 'AI_GENERATED',
          severity: item.severity,
          status: "PENDING" as const,
          title: item.title,
          description: item.description,
          evidence: item.evidence as Prisma.InputJsonValue,
          ...(item.deduplicationKey !== undefined
            ? { deduplicationKey: item.deduplicationKey }
            : {}),
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
      }),
    );

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
        auditVerdict: "APPROVED",
      },
      orderBy: {
        createdAt: "desc",
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
      orderBy: { createdAt: "desc" },
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
}
