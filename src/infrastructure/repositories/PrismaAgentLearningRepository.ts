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

interface MemoryContextRow {
  readonly id: string;
  readonly scope: string;
  readonly memory_type: string;
  readonly content: string;
  readonly confidence: number;
  readonly created_at: Date;
}

interface CaseContextRow {
  readonly decision_id: string;
  readonly decision: string;
  readonly reason_code: string | null;
  readonly reason: string | null;
  readonly recommendation_type: string;
  readonly title: string;
  readonly description: string;
  readonly created_at: Date;
}

interface PatternCountRow {
  readonly event_count: number;
  readonly tenant_count: number;
}

export class PrismaAgentLearningRepository implements IAgentLearningRepository {
  constructor(private readonly prisma: PrismaClient) {}

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

    await this.upsertKnowledgeNode({
      tenantId: input.tenantId,
      scope: 'LOCAL',
      nodeType: 'recommendation',
      externalId: input.recommendationId,
      label: input.title,
      metadata: {
        recommendationType: input.recommendationType,
        severity: input.severity,
      },
    });

    return this.toLearningEvent(row);
  }

  public async findQueuedEventById(eventId: string): Promise<QueuedAgentLearningEvent | null> {
    const row = await this.prisma.agentLearningEvent.findUnique({
      where: { id: eventId },
    });

    if (row === null) {
      return null;
    }

    if (row.decision !== 'APPROVED' && row.decision !== 'REJECTED') {
      return null;
    }

    return {
      id: row.id,
      tenantId: row.tenantId,
      recommendationId: row.recommendationId,
      decisionId: row.decisionId,
      userId: row.userId,
      decision: row.decision,
      reasonCode: row.reasonCode,
      ...(row.reason !== null ? { reason: row.reason } : {}),
    };
  }

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

    return this.toLearningEvent(row);
  }

  public async createMemory(input: CreateAgentMemoryInput): Promise<AgentMemory> {
    const row = await this.prisma.$transaction(async (tx) => {
      const memory = await tx.agentMemory.create({
        data: {
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
      });

      const memoryNode = await tx.agentKnowledgeNode.create({
        data: {
          ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
          scope: input.scope,
          nodeType: 'memory',
          externalId: memory.id,
          label: input.memoryType,
          metadata: {
            fingerprint: input.fingerprint,
            memoryType: input.memoryType,
          },
        },
      });

      const eventNode = await tx.agentKnowledgeNode.create({
        data: {
          ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
          scope: input.scope,
          nodeType: 'learning_event',
          externalId: input.sourceLearningEventId,
          label: 'Learning event',
          metadata: {
            sourceLearningEventId: input.sourceLearningEventId,
          },
        },
      });

      await tx.agentKnowledgeEdge.create({
        data: {
          ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
          sourceNodeId: memoryNode.id,
          targetNodeId: eventNode.id,
          relationType: 'DERIVED_FROM',
          confidence: input.confidence,
          sourceLearningEventId: input.sourceLearningEventId,
        },
      });

      return memory;
    });

    return this.toMemory(row);
  }

  public async findRecommendationLearningContext(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<AgentLearningContext> {
    const queryText = input.queryText.trim();
    const [memories, cases] = await Promise.all([
      this.prisma.$queryRaw<MemoryContextRow[]>`
        select id,
               scope::text as scope,
               memory_type::text as memory_type,
               content,
               confidence::float8 as confidence,
               created_at
        from agent_memory
        where active = true
          and (scope = 'GLOBAL'::"AgentMemoryScope" or tenant_id = ${input.tenantId})
          and (
            ${queryText} = ''
            or to_tsvector('spanish', coalesce(content, '')) @@ plainto_tsquery('spanish', ${queryText})
          )
        order by
          case when scope = 'GLOBAL'::"AgentMemoryScope" then 0 else 1 end,
          confidence desc,
          created_at desc
        limit ${input.limit}
      `,
      this.prisma.$queryRaw<CaseContextRow[]>`
        select d.id as decision_id,
               d.decision::text as decision,
               d.reason_code::text as reason_code,
               d.reason,
               r.type as recommendation_type,
               r.title,
               r.description,
               d.created_at
        from recommendation_decisions d
        inner join recommendations r on r.id = d.recommendation_id
        where r.tenant_id = ${input.tenantId}
          and d.reason_code is not null
          and (
            ${queryText} = ''
            or to_tsvector(
              'spanish',
              coalesce(r.title, '') || ' ' || coalesce(r.description, '') || ' ' || coalesce(d.reason, '')
            ) @@ plainto_tsquery('spanish', ${queryText})
          )
        order by d.created_at desc
        limit ${input.limit}
      `,
    ]);

    const memoryLines = memories.map((memory) => (
      `Memoria ${memory.scope}/${memory.memory_type}: ${memory.content}`
    ));
    const caseLines = cases.map((item) => (
      `Caso ${item.decision} (${item.reason_code ?? 'SIN_MOTIVO'}) en ${item.recommendation_type}: ${item.title}. ${item.reason ?? item.description}`
    ));

    return {
      memoryIds: memories.map((memory) => memory.id),
      caseIds: cases.map((item) => item.decision_id),
      summary: [...memoryLines, ...caseLines].join('\n'),
    };
  }

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
      memories: memories.map((memory) => ({
        id: memory.id,
        scope: memory.scope,
        memoryType: memory.memoryType,
        content: memory.content,
        confidence: memory.confidence,
        createdAt: memory.createdAt,
      })),
      events: events.map((event) => ({
        id: event.id,
        recommendationId: event.recommendationId,
        decisionId: event.decisionId,
        status: event.status,
        createdAt: event.createdAt,
      })),
    };
  }

  public async countSimilarApprovedEvents(input: {
    readonly reasonCode: CreateAgentLearningEventInput['reasonCode'];
    readonly recommendationType: string;
    readonly decision: 'APPROVED' | 'REJECTED';
  }): Promise<SimilarLearningPatternCount> {
    const rows = await this.prisma.$queryRaw<PatternCountRow[]>`
      select count(*)::int as event_count,
             count(distinct tenant_id)::int as tenant_count
      from agent_learning_events
      where status = 'APPROVED'::"AgentLearningStatus"
        and reason_code = ${input.reasonCode}::"RecommendationFeedbackReason"
        and recommendation_type = ${input.recommendationType}
        and decision = ${input.decision}::"RecommendationDecisionType"
    `;

    return {
      eventCount: rows[0]?.event_count ?? 0,
      tenantCount: rows[0]?.tenant_count ?? 0,
    };
  }

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

  private async upsertKnowledgeNode(input: {
    readonly tenantId: string;
    readonly scope: 'LOCAL' | 'GLOBAL';
    readonly nodeType: string;
    readonly externalId: string;
    readonly label: string;
    readonly metadata: unknown;
  }): Promise<void> {
    const existing = await this.prisma.agentKnowledgeNode.findFirst({
      where: {
        tenantId: input.tenantId,
        nodeType: input.nodeType,
        externalId: input.externalId,
      },
    });

    if (existing !== null) {
      return;
    }

    await this.prisma.agentKnowledgeNode.create({
      data: {
        tenantId: input.tenantId,
        scope: input.scope,
        nodeType: input.nodeType,
        externalId: input.externalId,
        label: input.label,
        metadata: input.metadata as Prisma.InputJsonValue,
      },
    });
  }

  private toLearningEvent(row: Awaited<ReturnType<PrismaClient['agentLearningEvent']['findFirst']>> & {}): AgentLearningEvent {
    return {
      id: row.id,
      tenantId: row.tenantId,
      recommendationId: row.recommendationId,
      decisionId: row.decisionId,
      status: row.status,
      ...(row.auditVerdict !== null ? { auditVerdict: row.auditVerdict } : {}),
      ...(row.auditScore !== null ? { auditScore: row.auditScore } : {}),
      createdAt: row.createdAt,
    };
  }

  private toMemory(row: Awaited<ReturnType<PrismaClient['agentMemory']['findFirst']>> & {}): AgentMemory {
    return {
      id: row.id,
      ...(row.tenantId !== null ? { tenantId: row.tenantId } : {}),
      scope: row.scope,
      memoryType: row.memoryType,
      content: row.content,
      confidence: row.confidence,
      active: row.active,
      createdAt: row.createdAt,
    };
  }
}
