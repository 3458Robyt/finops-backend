import type {
  CreateAgentLearningEventInput,
  SimilarLearningPatternCount,
} from "../../domain/interfaces/IAgentLearningRepository.js";
import type {
  AgentLearningContext,
  AgentLearningSummary,
} from "../../domain/interfaces/IAgentLearningService.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import {
  toCaseContextLine,
  toMemoryContextLine,
  toSummaryEvent,
  toSummaryMemory,
} from "./mappers/agentLearningMappers.js";
import {
  countSimilarApprovedEventRows,
  queryRecommendationLearningContext,
} from "./queries/agentLearningSearchQueries.js";
import { queryLearningSummaryStats } from "./queries/agentLearningSummaryQueries.js";

/** Reads learning context, summaries and cross-tenant promotion signals. */
export class PrismaAgentLearningQueryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findRecommendationLearningContext(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<AgentLearningContext> {
    const queryText = input.queryText.trim();
    const { memories, cases } = await queryRecommendationLearningContext(
      this.prisma,
      input.tenantId,
      queryText,
      input.limit,
    );

    const memoryLines = memories.map(toMemoryContextLine);
    const caseLines = cases.map(toCaseContextLine);

    return {
      memoryIds: memories.map((memory) => memory.id),
      caseIds: cases.map((item) => item.decision_id),
      summary: [...memoryLines, ...caseLines].join("\n"),
    };
  }

  /**
   * Obtiene un resumen del aprendizaje del agente para un tenant: las memorias
   * relevantes y los eventos de aprendizaje recientes.
   *
   * Carga en paralelo hasta 20 memorias activas (de ámbito `GLOBAL` o del propio
   * `tenantId`, aislamiento multi-tenant), hasta 20 eventos recientes y métricas
   * agregadas del tenant. Las métricas se calculan en PostgreSQL y no dependen
   * del límite de elementos mostrado en el resumen.
   *
   * @param tenantId Tenant del que se construye el resumen.
   * @returns Resumen con memorias y eventos; colecciones vacías si no hay datos.
   */

  public async findSummary(tenantId: string): Promise<AgentLearningSummary> {
    const [memories, events, statsRow, activeMemories, globalMemories] =
      await Promise.all([
        this.prisma.agentMemory.findMany({
          where: {
            active: true,
            OR: [{ scope: "GLOBAL" }, { tenantId }],
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        this.prisma.agentLearningEvent.findMany({
          where: { tenantId },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        queryLearningSummaryStats(this.prisma, tenantId),
        this.prisma.agentMemory.count({
          where: {
            active: true,
            OR: [{ scope: "GLOBAL" }, { scope: "LOCAL", tenantId }],
          },
        }),
        this.prisma.agentMemory.count({
          where: { active: true, scope: "GLOBAL" },
        }),
      ]);

    return {
      stats: {
        totalEvents: statsRow.total_events,
        feedbackApproved: statsRow.feedback_approved,
        feedbackRejected: statsRow.feedback_rejected,
        learningPending: statsRow.learning_pending,
        learningApproved: statsRow.learning_approved,
        learningRejected: statsRow.learning_rejected,
        learningSkipped: statsRow.learning_skipped,
        learningError: statsRow.learning_error,
        activeMemories,
        globalMemories,
        shadowMemories: statsRow.global_shadow_memories,
      },
      memories: memories.map(toSummaryMemory),
      events: events.map(toSummaryEvent),
    };
  }

  /**
   * Cuenta, mediante SQL crudo, los eventos de aprendizaje aprobados que comparten
   * un mismo patrón de decisión, de forma transversal a todos los tenants.
   *
   * Calcula cuántos eventos (`event_count`) y cuántos tenants distintos
   * (`tenant_count`) coinciden con el patrón formado por `reason_code`,
   * `recommendation_type` y `decision`, restringido a estado `APPROVED`. Sirve
   * para evaluar si un aprendizaje es lo bastante recurrente/generalizado como
   * para promoverse a memoria global. No filtra por tenant de forma intencionada
   * (mide consenso entre tenants).
   *
   * @param input Patrón a contar (reason code, tipo de recomendación y decisión).
   * @returns Recuento de eventos y de tenants distintos (0 si no hay
   *   coincidencias).
   */

  public async countSimilarApprovedEvents(input: {
    readonly reasonCode: CreateAgentLearningEventInput["reasonCode"];
    readonly recommendationType: string;
    readonly decision: "APPROVED" | "REJECTED";
  }): Promise<SimilarLearningPatternCount> {
    const rows = await countSimilarApprovedEventRows(this.prisma, input);

    return {
      eventCount: rows[0]?.event_count ?? 0,
      tenantCount: rows[0]?.tenant_count ?? 0,
    };
  }

  /**
   * Indica si ya existe una memoria global activa con un `fingerprint` dado.
   *
   * Se usa para deduplicar memorias `GLOBAL`: evita promover un aprendizaje ya
   * representado por otra memoria global con la misma huella.
   *
   * @param fingerprint Huella que identifica el contenido del aprendizaje.
   * @returns `true` si existe al menos una memoria global activa con ese
   *   fingerprint; `false` en caso contrario.
   */

  public async hasActiveGlobalMemory(fingerprint: string): Promise<boolean> {
    const count = await this.prisma.agentMemory.count({
      where: {
        scope: "GLOBAL",
        fingerprint,
        active: true,
      },
    });

    return count > 0;
  }

  /** Evita duplicar candidatos GLOBAL aunque todavía estén en shadow. */
  public async hasGlobalMemoryCandidate(fingerprint: string): Promise<boolean> {
    const count = await this.prisma.agentMemory.count({
      where: {
        scope: 'GLOBAL',
        fingerprint,
      },
    });

    return count > 0;
  }
}
