import type {
  CompleteAgentLearningEventInput,
  CreateAgentLearningEventInput,
  CreateAgentMemoryInput,
  IAgentLearningRepository,
  QueuedAgentLearningEvent,
  SimilarLearningPatternCount,
} from '../../domain/interfaces/IAgentLearningRepository.js';
import type {
  AgentLearningContext,
  AgentLearningSummary,
} from '../../domain/interfaces/IAgentLearningService.js';
import type { AgentLearningEvent, AgentMemory } from '../../domain/models/AgentLearning.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  toCaseContextLine,
  toLearningEvent,
  toMemory,
  toMemoryContextLine,
  toSummaryEvent,
  toSummaryMemory,
} from './mappers/agentLearningMappers.js';
import {
  countSimilarApprovedEventRows,
  queryRecommendationLearningContext,
} from './queries/agentLearningSearchQueries.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link IAgentLearningRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: persistir y consultar el aprendizaje del agente IA. Gestiona
 * los eventos de aprendizaje (`agent_learning_events`), las memorias del agente
 * (`agent_memory`, con ámbito `LOCAL` por tenant o `GLOBAL` compartido) y las
 * consultas de texto completo. Incluye consultas de texto
 * completo (en español) sobre memorias y casos previos, y el conteo de patrones
 * de decisión similares. Las operaciones por tenant aplican aislamiento
 * multi-tenant, salvo las memorias `GLOBAL`, que se comparten entre tenants.
 */
export class PrismaAgentLearningRepository implements IAgentLearningRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Crea un evento de aprendizaje a partir de una decisión sobre una
   * recomendación.
   *
   * Persiste el evento en estado inicial `PENDING` (el procesamiento/auditoría
   * ocurre después) y luego asegura (idempotente) un nodo de conocimiento de tipo
   * `recommendation` para el grafo. El `severity` se castea al enum del dominio;
   * `reason` es opcional.
   *
   * @param input Datos del evento (tenant, recomendación, decisión, motivo, tipo,
   *   severidad, títulos y evidencia).
   * @returns El evento de aprendizaje creado en formato de dominio.
   */
  public async createEvent(input: CreateAgentLearningEventInput): Promise<AgentLearningEvent> {
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
        severity: input.severity as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
        title: input.title,
        description: input.description,
        evidenceSummary: input.evidenceSummary,
        status: 'PENDING',
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
  public async findQueuedEventById(eventId: string): Promise<QueuedAgentLearningEvent | null> {
    const row = await this.prisma.agentLearningEvent.findUnique({
      where: { id: eventId },
    });

    if (row === null) {
      return null;
    }

    if (row.status !== 'PENDING' || (row.decision !== 'APPROVED' && row.decision !== 'REJECTED')) {
      return null;
    }

    return {
      id: row.id,
      tenantId: row.tenantId,
      recommendationId: row.recommendationId,
      decisionId: row.decisionId,
      userId: row.userId,
      decision: row.decision as 'APPROVED' | 'REJECTED',
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
        decision: row.decision as 'APPROVED' | 'REJECTED',
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
  }): Promise<'PENDING' | 'SKIPPED'> {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.agentLearningEvent.findUnique({
        where: { id: input.eventId },
        select: { attempts: true, maxAttempts: true, decisionId: true, lockedBy: true },
      });
      if (event === null || event.lockedBy !== input.workerId) {
        return 'SKIPPED';
      }

      const status = event.attempts >= event.maxAttempts ? 'SKIPPED' : 'PENDING';
      await tx.agentLearningEvent.update({
        where: { id: input.eventId },
        data: {
          status,
          errorMessage: input.errorMessage,
          ...(status === 'PENDING' ? { nextAttemptAt: input.nextAttemptAt } : {}),
          lockedAt: null,
          lockedBy: null,
        },
      });
      await tx.recommendationDecision.update({
        where: { id: event.decisionId },
        data: {
          learningStatus: status,
          ...(status === 'SKIPPED' ? { learningProcessedAt: new Date() } : {}),
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
  public async completeEvent(input: CompleteAgentLearningEventInput): Promise<AgentLearningEvent> {
    const row = await this.prisma.$transaction(async (tx) => {
      const event = await tx.agentLearningEvent.update({
        where: { id: input.eventId },
        data: {
          status: input.status,
          ...(input.auditVerdict !== undefined ? { auditVerdict: input.auditVerdict as 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION' } : {}),
          ...(input.auditScore !== undefined ? { auditScore: input.auditScore } : {}),
          ...(input.auditReport !== undefined ? { auditReport: input.auditReport as Prisma.InputJsonValue } : {}),
          ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
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
  public async createMemory(input: CreateAgentMemoryInput): Promise<AgentMemory> {
    const row = await this.prisma.$transaction(async (tx) => {
      const memory = await tx.agentMemory.upsert({
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
          auditVerdict: input.auditVerdict as 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION',
          auditScore: input.auditScore,
          auditReport: input.auditReport as Prisma.InputJsonValue,
          fingerprint: input.fingerprint,
        },
        update: {},
      });

      return memory;
    });

    return toMemory(row);
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
      summary: [...memoryLines, ...caseLines].join('\n'),
    };
  }

  /**
   * Obtiene un resumen del aprendizaje del agente para un tenant: las memorias
   * relevantes y los eventos de aprendizaje recientes.
   *
   * Carga en paralelo hasta 20 memorias activas (de ámbito `GLOBAL` o del propio
   * `tenantId`, aislamiento multi-tenant) y hasta 20 eventos de aprendizaje del
   * tenant, ambos ordenados por recencia, proyectando solo los campos necesarios
   * para el resumen.
   *
   * @param tenantId Tenant del que se construye el resumen.
   * @returns Resumen con memorias y eventos; colecciones vacías si no hay datos.
   */
  public async findSummary(tenantId: string): Promise<AgentLearningSummary> {
    const [memories, events] = await Promise.all([
      this.prisma.agentMemory.findMany({
        where: {
          active: true,
          OR: [
            { scope: 'GLOBAL' },
            { tenantId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.agentLearningEvent.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
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
    readonly reasonCode: CreateAgentLearningEventInput['reasonCode'];
    readonly recommendationType: string;
    readonly decision: 'APPROVED' | 'REJECTED';
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
        scope: 'GLOBAL',
        fingerprint,
        active: true,
      },
    });

    return count > 0;
  }
}
