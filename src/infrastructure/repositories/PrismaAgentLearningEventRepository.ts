import type {
  CompleteAgentLearningEventInput,
  CreateAgentLearningEventInput,
  QueuedAgentLearningEvent,
  RecordApprovedLearningInput,
} from "../../domain/interfaces/IAgentLearningRepository.js";
import type { AgentLearningEvent } from "../../domain/models/AgentLearning.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { toLearningEvent } from "./mappers/agentLearningMappers.js";
import { PrismaAgentLearningMemoryRepository } from "./PrismaAgentLearningMemoryRepository.js";

/** Persists learning events and their atomic audited state transitions. */
export class PrismaAgentLearningEventRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly memoryRepository: PrismaAgentLearningMemoryRepository,
  ) {}

  public async createEvent(
    input: CreateAgentLearningEventInput,
  ): Promise<AgentLearningEvent> {
    const row = await this.prisma.agentLearningEvent.create({
      data: {
        tenantId: input.tenantId,
        recommendationId: input.recommendationId,
        decisionId: input.decisionId,
        userId: input.userId,
        decision: input.decision,
        reasonCode: input.reasonCode,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        recommendationType: input.recommendationType,
        cloudAccountId: input.cloudAccountId,
        severity: input.severity as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
        title: input.title,
        description: input.description,
        evidenceSummary: input.evidenceSummary,
        status: "PENDING",
      },
    });

    return toLearningEvent(row);
  }

  /**
   * Busca un evento de aprendizaje en cola por su id, validando que esté listo
   * para procesarse.
   *
   * Devuelve `null` si el evento no existe o si su decisión no es `APPROVED` ni
   * `REJECTED` (solo esos dos casos representan decisiones humanas accionables
   * para el aprendizaje). El campo `reason` solo se incluye cuando no es `null`.
   *
   * @param eventId Identificador del evento de aprendizaje.
   * @returns El evento en cola en formato reducido, o `null` si no aplica.
   */

  public async findQueuedEventById(
    eventId: string,
  ): Promise<QueuedAgentLearningEvent | null> {
    const row = await this.prisma.agentLearningEvent.findUnique({
      where: { id: eventId },
    });

    if (row === null) {
      return null;
    }

    if (
      row.status !== "PENDING" ||
      (row.decision !== "APPROVED" && row.decision !== "REJECTED")
    ) {
      return null;
    }

    return {
      id: row.id,
      tenantId: row.tenantId,
      recommendationId: row.recommendationId,
      decisionId: row.decisionId,
      userId: row.userId,
      decision: row.decision as "APPROVED" | "REJECTED",
      reasonCode: row.reasonCode,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      ...(row.reason !== null ? { reason: row.reason } : {}),
    };
  }

  public async claimNextQueuedEvent(input: {
    readonly workerId: string;
    readonly leaseExpiredBefore: Date;
  }): Promise<QueuedAgentLearningEvent | null> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<readonly { readonly id: string }[]>`
        SELECT id
        FROM agent_learning_events
        WHERE status = 'PENDING'
          AND next_attempt_at <= ${now}
          AND attempts < max_attempts
          AND (locked_at IS NULL OR locked_at < ${input.leaseExpiredBefore})
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const claimed = rows[0];
      if (claimed === undefined) {
        return null;
      }

      const row = await tx.agentLearningEvent.update({
        where: { id: claimed.id },
        data: {
          attempts: { increment: 1 },
          lockedAt: now,
          lockedBy: input.workerId,
        },
      });

      return {
        id: row.id,
        tenantId: row.tenantId,
        recommendationId: row.recommendationId,
        decisionId: row.decisionId,
        userId: row.userId,
        decision: row.decision as "APPROVED" | "REJECTED",
        reasonCode: row.reasonCode,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        ...(row.reason !== null ? { reason: row.reason } : {}),
      };
    });
  }

  public async releaseEventForRetry(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date;
  }): Promise<"PENDING" | "SKIPPED"> {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.agentLearningEvent.findUnique({
        where: { id: input.eventId },
        select: {
          attempts: true,
          maxAttempts: true,
          decisionId: true,
          lockedBy: true,
        },
      });
      if (event === null || event.lockedBy !== input.workerId) {
        return "SKIPPED";
      }

      const status =
        event.attempts >= event.maxAttempts ? "SKIPPED" : "PENDING";
      await tx.agentLearningEvent.update({
        where: { id: input.eventId },
        data: {
          status,
          errorMessage: input.errorMessage,
          ...(status === "PENDING"
            ? { nextAttemptAt: input.nextAttemptAt }
            : {}),
          lockedAt: null,
          lockedBy: null,
        },
      });
      await tx.recommendationDecision.update({
        where: { id: event.decisionId },
        data: {
          learningStatus: status,
          ...(status === "SKIPPED" ? { learningProcessedAt: new Date() } : {}),
        },
      });
      return status;
    });
  }

  /**
   * Finaliza el procesamiento de un evento de aprendizaje y sincroniza la
   * decisión asociada, de forma atómica.
   *
   * Dentro de una transacción: (1) actualiza el evento con su estado final y los
   * datos de auditoría opcionales (`auditVerdict` casteado al enum del dominio,
   * `auditScore`, `auditReport` como JSON, `errorMessage`); y (2) propaga el
   * estado al `recommendation_decisions` correspondiente, marcando
   * `learningProcessedAt`.
   *
   * @param input Datos de cierre del evento (id, estado y resultados de
   *   auditoría opcionales).
   * @returns El evento de aprendizaje actualizado en formato de dominio.
   */

  public async completeEvent(
    input: CompleteAgentLearningEventInput,
  ): Promise<AgentLearningEvent> {
    const row = await this.prisma.$transaction(async (tx) => {
      const event = await tx.agentLearningEvent.update({
        where: { id: input.eventId },
        data: {
          status: input.status,
          ...(input.auditVerdict !== undefined
            ? {
                auditVerdict: input.auditVerdict as
                  "APPROVED" | "REJECTED" | "NEEDS_REVISION",
              }
            : {}),
          ...(input.auditScore !== undefined
            ? { auditScore: input.auditScore }
            : {}),
          ...(input.auditReport !== undefined
            ? { auditReport: input.auditReport as Prisma.InputJsonValue }
            : {}),
          ...(input.errorMessage !== undefined
            ? { errorMessage: input.errorMessage }
            : {}),
          lockedAt: null,
          lockedBy: null,
        },
      });

      await tx.recommendationDecision.update({
        where: { id: event.decisionId },
        data: {
          learningStatus: input.status,
          learningProcessedAt: new Date(),
        },
      });

      return event;
    });

    return toLearningEvent(row);
  }

  /**
   * Crea una memoria del agente, de forma
   * atómica.
   *
   * Dentro de una transacción: (1) crea la memoria (con su veredicto/score/reporte
   * de auditoría, `metadata` y `fingerprint`; el `tenantId` es opcional porque las
   * memorias `GLOBAL` no pertenecen a un tenant); (2) crea un nodo de tipo
   * `memory` y otro de tipo `learning_event`; y (3) crea una arista
   * `DERIVED_FROM` entre la memoria y su evento de origen, registrando la
   * confianza. Esto deja trazada la procedencia del aprendizaje en el grafo.
   *
   * @param input Datos de la memoria a crear y su evento de origen.
   * @returns La memoria creada en formato de dominio.
   */

  public async recordApprovedLearning(
    input: RecordApprovedLearningInput,
  ): Promise<AgentLearningEvent> {
    const row = await this.prisma.$transaction(async (tx) => {
      for (const memory of input.memories) {
        await this.memoryRepository.upsertMemory(tx, memory);
      }

      const event = await tx.agentLearningEvent.update({
        where: { id: input.eventId },
        data: {
          status: "APPROVED",
          auditVerdict: input.auditVerdict as
            "APPROVED" | "REJECTED" | "NEEDS_REVISION",
          auditScore: input.auditScore,
          auditReport: input.auditReport as Prisma.InputJsonValue,
          lockedAt: null,
          lockedBy: null,
        },
      });

      await tx.recommendationDecision.update({
        where: { id: event.decisionId },
        data: {
          learningStatus: "APPROVED",
          learningProcessedAt: new Date(),
        },
      });

      return event;
    });

    return toLearningEvent(row);
  }
}
