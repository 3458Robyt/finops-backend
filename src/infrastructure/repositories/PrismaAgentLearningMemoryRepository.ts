import type { CreateAgentMemoryInput } from "../../domain/interfaces/IAgentLearningRepository.js";
import type { AgentMemory, GlobalLearningCanaryEvidence } from "../../domain/models/AgentLearning.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { toMemory } from "./mappers/agentLearningMappers.js";

/** Persists tenant-local and global audited agent memories. */
export class PrismaAgentLearningMemoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createMemory(
    input: CreateAgentMemoryInput,
  ): Promise<AgentMemory> {
    const row = await this.prisma.$transaction(async (tx) => {
      return this.upsertMemory(tx, input);
    });

    return toMemory(row);
  }

  public async deactivateMemory(input: {
    readonly tenantId: string;
    readonly memoryId: string;
    readonly allowGlobal: boolean;
    readonly actorUserId: string;
  }): Promise<AgentMemory | null> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.agentMemory.findFirst({
        where: {
          id: input.memoryId,
          active: true,
          OR: [
            { scope: 'LOCAL', tenantId: input.tenantId },
            ...(input.allowGlobal ? [{ scope: 'GLOBAL' as const }] : []),
          ],
        },
      });
      if (current === null) return null;
      const metadata = isRecord(current.metadata) ? current.metadata : {};
      const updated = await tx.agentMemory.update({
        where: { id: current.id },
        data: {
          active: false,
          metadata: {
            ...metadata,
            lifecycle: 'DEACTIVATED',
            deactivatedAt: new Date().toISOString(),
            deactivatedByUserId: input.actorUserId,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.agentInstructionAuditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: 'AGENT_MEMORY_DEACTIVATED',
          entityType: 'AGENT_MEMORY',
          entityId: current.id,
          metadata: {
            scope: current.scope,
            lifecycle: 'DEACTIVATED',
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
    return row === null ? null : toMemory(row);
  }

  /** Promueve un candidato GLOBAL solo con evidencia live y auditoría persistida. */
  public async promoteGlobalMemoryWithEvidence(input: {
    readonly sourceLearningEventId: string;
    readonly actorUserId: string;
    readonly evidence: GlobalLearningCanaryEvidence;
  }): Promise<AgentMemory | null> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.agentMemory.findFirst({
        where: {
          sourceLearningEventId: input.sourceLearningEventId,
          scope: 'GLOBAL',
          active: false,
        },
      });
      if (current === null) return null;
      if (input.evidence.candidateMemoryId !== current.id) return null;
      const metadata = isRecord(current.metadata) ? current.metadata : {};
      if (metadata['learningLifecycle'] !== 'SHADOW') return null;
      const promoted = await tx.agentMemory.update({
        where: { id: current.id },
        data: {
          active: true,
          metadata: {
            ...metadata,
            learningLifecycle: 'PROMOTED',
            promotedAt: new Date().toISOString(),
            promotionEvidence: input.evidence,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.agentInstructionAuditEvent.create({
        data: {
          actorUserId: input.actorUserId,
          action: 'AGENT_GLOBAL_MEMORY_PROMOTED',
          entityType: 'AGENT_MEMORY',
          entityId: current.id,
          metadata: {
            sourceLearningEventId: input.sourceLearningEventId,
            canaryRunId: input.evidence.runId,
            candidateMemoryId: input.evidence.candidateMemoryId,
            mode: input.evidence.mode,
          } as Prisma.InputJsonValue,
        },
      });
      return promoted;
    });
    return row === null ? null : toMemory(row);
  }

  public async upsertMemory(
    tx: Prisma.TransactionClient,
    input: CreateAgentMemoryInput,
  ) {
    return tx.agentMemory.upsert({
      where: {
        sourceLearningEventId_scope: {
          sourceLearningEventId: input.sourceLearningEventId,
          scope: input.scope,
        },
      },
      create: {
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        scope: input.scope,
        memoryType: input.memoryType,
        content: input.content,
        confidence: input.confidence,
        active: input.active ?? true,
        sourceLearningEventId: input.sourceLearningEventId,
        metadata: input.metadata as Prisma.InputJsonValue,
        auditVerdict: input.auditVerdict as
          "APPROVED" | "REJECTED" | "NEEDS_REVISION",
        auditScore: input.auditScore,
        auditReport: input.auditReport as Prisma.InputJsonValue,
        fingerprint: input.fingerprint,
      },
      update: {},
    });
  }

  /**
   * Construye el contexto de aprendizaje relevante para una recomendación,
   * combinando memorias y casos previos mediante búsqueda de texto completo.
   *
   * Ejecuta en paralelo dos consultas SQL crudas con full-text search en español
   * (`to_tsvector('spanish', ...)` + `plainto_tsquery`):
   * - Memorias activas visibles para el tenant: incluye las de ámbito `GLOBAL`
   *   (compartidas entre tenants) y las `LOCAL` del propio `tenantId` (aislamiento
   *   multi-tenant). Prioriza las `GLOBAL`, luego por confianza y recencia.
   * - Casos previos: decisiones sobre recomendaciones del tenant que tengan
   *   `reason_code`, uniendo `recommendation_decisions` con `recommendations` y
   *   buscando en título, descripción y motivo.
   * Cuando `queryText` está vacío, ambas consultas omiten el filtro de texto y
   * devuelven los registros más relevantes/recientes. Finalmente compone un
   * resumen textual con una línea por memoria y por caso.
   *
   * @param input Tenant, texto de consulta y límite por cada fuente.
   * @returns Identificadores de memorias y casos usados y un resumen textual
   *   concatenado.
   */
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
