import type { CreateAgentMemoryInput } from "../../domain/interfaces/IAgentLearningRepository.js";
import type { AgentMemory } from "../../domain/models/AgentLearning.js";
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
