import type {
  ActivateAgentProfileInput,
  CompleteContextBuildRunInput,
  CreateAiContextTraceInput,
  CreateContextBuildRunInput,
  CreateTenantAgentRuleInput,
  FocusResourcePeriodAggregate,
  IAgentContextRepository,
  UpsertContextSummaryInput,
  UpsertKnowledgeEdgeInput,
  UpsertKnowledgeNodeInput,
} from '../../domain/interfaces/IAgentContextRepository.js';
import type {
  AgentInstructionProfile,
  AiContextTrace,
  ContextArtifact,
  KnowledgeGraphContext,
  TenantAgentRule,
} from '../../domain/models/AgentContext.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

interface FocusAggregateRow {
  readonly tenant_id: string;
  readonly provider: string;
  readonly cloud_account_id: string;
  readonly service_name: string;
  readonly resource_id: string;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly billed_cost: number;
  readonly consumed_quantity: number | null;
  readonly consumed_unit: string | null;
  readonly currency: string;
  readonly metric_count: number;
}

export class PrismaAgentContextRepository implements IAgentContextRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findActiveProfile(): Promise<AgentInstructionProfile | null> {
    const row = await this.prisma.agentInstructionProfile.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
    });

    return row === null ? null : this.toProfile(row);
  }

  public async activateProfile(input: ActivateAgentProfileInput): Promise<AgentInstructionProfile> {
    const row = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.agentInstructionProfile.findFirst({
        orderBy: { version: 'desc' },
      });
      const version = (latest?.version ?? 0) + 1;

      await tx.agentInstructionProfile.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'ARCHIVED' },
      });

      return tx.agentInstructionProfile.create({
        data: {
          version,
          status: 'ACTIVE',
          structuredRules: input.structuredRules as unknown as Prisma.InputJsonValue,
          ...(input.freeformNotes !== undefined ? { freeformNotes: input.freeformNotes } : {}),
          validationReport: input.validationReport as unknown as Prisma.InputJsonValue,
          activatedAt: new Date(),
          createdByUserId: input.actorUserId,
          activatedByUserId: input.actorUserId,
        },
      });
    });

    return this.toProfile(row);
  }

  public async listTenantRules(tenantId: string): Promise<TenantAgentRule[]> {
    const rows = await this.prisma.tenantAgentRule.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    return rows.map(this.toTenantRule);
  }

  public async createTenantRule(input: CreateTenantAgentRuleInput): Promise<TenantAgentRule> {
    const row = await this.prisma.tenantAgentRule.create({
      data: {
        tenantId: input.tenantId,
        category: input.category,
        ruleText: input.ruleText,
        priority: input.priority,
        createdByUserId: input.createdByUserId,
      },
    });

    return this.toTenantRule(row);
  }

  public async disableTenantRule(tenantId: string, ruleId: string): Promise<TenantAgentRule | null> {
    const existing = await this.prisma.tenantAgentRule.findFirst({
      where: { id: ruleId, tenantId },
    });

    if (existing === null) {
      return null;
    }

    const row = await this.prisma.tenantAgentRule.update({
      where: { id: ruleId },
      data: {
        status: 'DISABLED',
        disabledAt: new Date(),
      },
    });

    return this.toTenantRule(row);
  }

  public async createInstructionAuditEvent(input: {
    readonly tenantId?: string;
    readonly actorUserId?: string;
    readonly action: string;
    readonly entityType: string;
    readonly entityId?: string;
    readonly metadata?: unknown;
  }): Promise<void> {
    await this.prisma.agentInstructionAuditEvent.create({
      data: {
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        action: input.action,
        entityType: input.entityType,
        ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  public async findContextSummaries(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<ContextArtifact[]> {
    const tokens = input.queryText
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .slice(0, 8);

    const rows = await this.prisma.contextSummaryCache.findMany({
      where: {
        tenantId: input.tenantId,
        ...(tokens.length > 0
          ? {
              OR: tokens.flatMap((token) => [
                { summary: { contains: token, mode: 'insensitive' as const } },
                { scopeKey: { contains: token, mode: 'insensitive' as const } },
                { serviceName: { contains: token, mode: 'insensitive' as const } },
                { resourceId: { contains: token, mode: 'insensitive' as const } },
              ]),
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: input.limit,
    });

    return rows.map((row) => ({
      id: row.id,
      artifactType: row.artifactType,
      scopeKey: row.scopeKey,
      summary: row.summary,
      tokenEstimate: row.tokenEstimate,
      ...(row.provider !== null ? { provider: row.provider } : {}),
      ...(row.cloudAccountId !== null ? { cloudAccountId: row.cloudAccountId } : {}),
      ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
      ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
      ...(row.evidenceRefs !== null ? { evidenceRefs: row.evidenceRefs } : {}),
    }));
  }

  public async upsertContextSummary(input: UpsertContextSummaryInput): Promise<ContextArtifact> {
    const row = await this.prisma.contextSummaryCache.upsert({
      where: {
        tenantId_artifactType_scopeKey_sourceHash: {
          tenantId: input.tenantId,
          artifactType: input.artifactType,
          scopeKey: input.scopeKey,
          sourceHash: input.sourceHash,
        },
      },
      update: {
        summary: input.summary,
        tokenEstimate: input.tokenEstimate,
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.cloudAccountId !== undefined ? { cloudAccountId: input.cloudAccountId } : {}),
        ...(input.serviceName !== undefined ? { serviceName: input.serviceName } : {}),
        ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
        ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
        ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
        ...(input.facts !== undefined ? { facts: input.facts as Prisma.InputJsonValue } : {}),
        ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs as Prisma.InputJsonValue } : {}),
      },
      create: {
        tenantId: input.tenantId,
        artifactType: input.artifactType,
        scopeKey: input.scopeKey,
        sourceHash: input.sourceHash,
        summary: input.summary,
        tokenEstimate: input.tokenEstimate,
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.cloudAccountId !== undefined ? { cloudAccountId: input.cloudAccountId } : {}),
        ...(input.serviceName !== undefined ? { serviceName: input.serviceName } : {}),
        ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
        ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
        ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
        ...(input.facts !== undefined ? { facts: input.facts as Prisma.InputJsonValue } : {}),
        ...(input.evidenceRefs !== undefined ? { evidenceRefs: input.evidenceRefs as Prisma.InputJsonValue } : {}),
      },
    });

    return {
      id: row.id,
      artifactType: row.artifactType,
      scopeKey: row.scopeKey,
      summary: row.summary,
      tokenEstimate: row.tokenEstimate,
      ...(row.provider !== null ? { provider: row.provider } : {}),
      ...(row.cloudAccountId !== null ? { cloudAccountId: row.cloudAccountId } : {}),
      ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
      ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
      ...(row.evidenceRefs !== null ? { evidenceRefs: row.evidenceRefs } : {}),
    };
  }

  public async createAiContextTrace(input: CreateAiContextTraceInput): Promise<AiContextTrace> {
    const row = await this.prisma.aiContextTrace.create({
      data: {
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        operation: input.operation,
        model: input.model,
        status: input.status,
        ...(input.profileVersion !== undefined ? { profileVersion: input.profileVersion } : {}),
        promptTokenEstimate: input.promptTokenEstimate,
        ...(input.responseTokenEstimate !== undefined ? { responseTokenEstimate: input.responseTokenEstimate } : {}),
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
        ...(input.artifactIds !== undefined ? { artifactIds: [...input.artifactIds] } : {}),
        ...(input.memoryIds !== undefined ? { memoryIds: [...input.memoryIds] } : {}),
        ...(input.knowledgeNodeIds !== undefined ? { knowledgeNodeIds: [...input.knowledgeNodeIds] } : {}),
        ...(input.tenantRuleIds !== undefined ? { tenantRuleIds: [...input.tenantRuleIds] } : {}),
        ...(input.conflicts !== undefined ? { conflicts: [...input.conflicts] } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      },
    });

    return this.toTrace(row);
  }

  public async listAiContextTraces(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<AiContextTrace[]> {
    const rows = await this.prisma.aiContextTrace.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });

    return rows.map(this.toTrace);
  }

  public async createContextBuildRun(input: CreateContextBuildRunInput): Promise<string> {
    const row = await this.prisma.contextBuildRun.create({
      data: {
        tenantId: input.tenantId,
        runType: input.runType,
        status: 'RUNNING',
        startedAt: new Date(),
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return row.id;
  }

  public async completeContextBuildRun(input: CompleteContextBuildRunInput): Promise<void> {
    await this.prisma.contextBuildRun.update({
      where: { id: input.runId },
      data: {
        status: input.status,
        completedAt: new Date(),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  public async listFocusResourcePeriodAggregates(tenantId: string): Promise<FocusResourcePeriodAggregate[]> {
    const rows = await this.prisma.$queryRaw<FocusAggregateRow[]>`
      select tenant_id,
             provider::text as provider,
             cloud_account_id,
             service_name,
             resource_id,
             date_trunc('month', charge_period_start) as period_start,
             date_trunc('month', charge_period_start) + interval '1 month' as period_end,
             coalesce(sum(billed_cost), 0)::float8 as billed_cost,
             case when count(distinct consumed_unit) = 1 then coalesce(sum(consumed_quantity), 0)::float8 else null end as consumed_quantity,
             case when count(distinct consumed_unit) = 1 then max(consumed_unit) else null end as consumed_unit,
             max(billing_currency) as currency,
             count(*)::int as metric_count
      from cost_metrics
      where tenant_id = ${tenantId}
        and resource_id <> ''
      group by tenant_id, provider, cloud_account_id, service_name, resource_id, date_trunc('month', charge_period_start)
      order by billed_cost desc
    `;

    return rows.map((row) => ({
      tenantId: row.tenant_id,
      provider: row.provider,
      cloudAccountId: row.cloud_account_id,
      serviceName: row.service_name,
      resourceId: row.resource_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      billedCost: row.billed_cost,
      ...(row.consumed_quantity !== null ? { consumedQuantity: row.consumed_quantity } : {}),
      ...(row.consumed_unit !== null ? { consumedUnit: row.consumed_unit } : {}),
      currency: row.currency,
      metricCount: row.metric_count,
    }));
  }

  public async upsertKnowledgeNode(input: UpsertKnowledgeNodeInput): Promise<string> {
    const row = await this.prisma.agentKnowledgeNode.upsert({
      where: {
        tenantId_dedupeKey: {
          tenantId: input.tenantId,
          dedupeKey: input.dedupeKey,
        },
      },
      update: {
        label: input.label,
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
      create: {
        tenantId: input.tenantId,
        scope: input.scope,
        nodeType: input.nodeType,
        dedupeKey: input.dedupeKey,
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        label: input.label,
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return row.id;
  }

  public async upsertKnowledgeEdge(input: UpsertKnowledgeEdgeInput): Promise<string> {
    const row = await this.prisma.agentKnowledgeEdge.upsert({
      where: {
        tenantId_dedupeKey: {
          tenantId: input.tenantId,
          dedupeKey: input.dedupeKey,
        },
      },
      update: {
        confidence: input.confidence,
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
      create: {
        tenantId: input.tenantId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        relationType: input.relationType,
        dedupeKey: input.dedupeKey,
        confidence: input.confidence,
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return row.id;
  }

  public async getKnowledgeGraph(input: {
    readonly tenantId: string;
    readonly recommendationId?: string;
    readonly resourceId?: string;
    readonly depth: number;
  }): Promise<KnowledgeGraphContext> {
    if (input.recommendationId === undefined && input.resourceId === undefined) {
      const [nodes, edges] = await Promise.all([
        this.prisma.agentKnowledgeNode.findMany({
          where: { tenantId: input.tenantId },
          orderBy: [
            { nodeType: 'asc' },
            { createdAt: 'desc' },
          ],
          take: 250,
        }),
        this.prisma.agentKnowledgeEdge.findMany({
          where: { tenantId: input.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 500,
        }),
      ]);

      const visibleNodeIds = new Set(nodes.map((node) => node.id));

      return {
        nodes: nodes.map((node) => ({
          id: node.id,
          nodeType: node.nodeType,
          label: node.label,
          ...(node.externalId !== null ? { externalId: node.externalId } : {}),
          ...(node.metadata !== null ? { metadata: node.metadata } : {}),
        })),
        edges: edges
          .filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
          .map((edge) => ({
            id: edge.id,
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            relationType: edge.relationType,
            confidence: edge.confidence,
            ...(edge.metadata !== null ? { metadata: edge.metadata } : {}),
          })),
      };
    }

    const startNodes = await this.prisma.agentKnowledgeNode.findMany({
      where: {
        tenantId: input.tenantId,
        OR: [
          ...(input.recommendationId !== undefined
            ? [{ nodeType: 'recommendation', externalId: input.recommendationId }]
            : []),
          ...(input.resourceId !== undefined
            ? [{ nodeType: 'resource_period', externalId: { startsWith: `${input.resourceId}:` } }]
            : []),
        ],
      },
      take: 20,
    });

    if (startNodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    const nodeIds = new Set(startNodes.map((node) => node.id));
    let frontier = startNodes.map((node) => node.id);
    const collectedEdges = new Map<string, Awaited<ReturnType<typeof this.prisma.agentKnowledgeEdge.findMany>>[number]>();

    for (let level = 0; level < Math.max(1, Math.min(input.depth, 2)); level += 1) {
      const edges = await this.prisma.agentKnowledgeEdge.findMany({
        where: {
          tenantId: input.tenantId,
          OR: [
            { sourceNodeId: { in: frontier } },
            { targetNodeId: { in: frontier } },
          ],
        },
      });

      frontier = [];

      for (const edge of edges) {
        collectedEdges.set(edge.id, edge);
        if (!nodeIds.has(edge.sourceNodeId)) {
          nodeIds.add(edge.sourceNodeId);
          frontier.push(edge.sourceNodeId);
        }
        if (!nodeIds.has(edge.targetNodeId)) {
          nodeIds.add(edge.targetNodeId);
          frontier.push(edge.targetNodeId);
        }
      }
    }

    const nodes = await this.prisma.agentKnowledgeNode.findMany({
      where: { id: { in: [...nodeIds] } },
    });

    return {
      nodes: nodes.map((node) => ({
        id: node.id,
        nodeType: node.nodeType,
        label: node.label,
        ...(node.externalId !== null ? { externalId: node.externalId } : {}),
        ...(node.metadata !== null ? { metadata: node.metadata } : {}),
      })),
      edges: [...collectedEdges.values()].map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        relationType: edge.relationType,
        confidence: edge.confidence,
        ...(edge.metadata !== null ? { metadata: edge.metadata } : {}),
      })),
    };
  }

  private toProfile(row: {
    readonly id: string;
    readonly version: number;
    readonly status: string;
    readonly structuredRules: unknown;
    readonly freeformNotes: string | null;
    readonly validationReport: unknown;
    readonly activatedAt: Date | null;
    readonly createdByUserId: string;
    readonly activatedByUserId: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }): AgentInstructionProfile {
    return {
      id: row.id,
      version: row.version,
      status: row.status as AgentInstructionProfile['status'],
      structuredRules: row.structuredRules as AgentInstructionProfile['structuredRules'],
      ...(row.freeformNotes !== null ? { freeformNotes: row.freeformNotes } : {}),
      ...(row.validationReport !== null
        ? { validationReport: row.validationReport as AgentInstructionProfile['validationReport'] }
        : {}),
      ...(row.activatedAt !== null ? { activatedAt: row.activatedAt } : {}),
      createdByUserId: row.createdByUserId,
      ...(row.activatedByUserId !== null ? { activatedByUserId: row.activatedByUserId } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toTenantRule(row: {
    readonly id: string;
    readonly tenantId: string;
    readonly category: string;
    readonly ruleText: string;
    readonly priority: number;
    readonly status: string;
    readonly disabledAt: Date | null;
    readonly createdByUserId: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }): TenantAgentRule {
    return {
      id: row.id,
      tenantId: row.tenantId,
      category: row.category,
      ruleText: row.ruleText,
      priority: row.priority,
      status: row.status as TenantAgentRule['status'],
      ...(row.disabledAt !== null ? { disabledAt: row.disabledAt } : {}),
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toTrace(row: {
    readonly id: string;
    readonly tenantId: string;
    readonly userId: string | null;
    readonly operation: string;
    readonly model: string;
    readonly status: string;
    readonly profileVersion: number | null;
    readonly promptTokenEstimate: number;
    readonly responseTokenEstimate: number | null;
    readonly latencyMs: number | null;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): AiContextTrace {
    return {
      id: row.id,
      tenantId: row.tenantId,
      ...(row.userId !== null ? { userId: row.userId } : {}),
      operation: row.operation as AiContextTrace['operation'],
      model: row.model,
      status: row.status,
      ...(row.profileVersion !== null ? { profileVersion: row.profileVersion } : {}),
      promptTokenEstimate: row.promptTokenEstimate,
      ...(row.responseTokenEstimate !== null ? { responseTokenEstimate: row.responseTokenEstimate } : {}),
      ...(row.latencyMs !== null ? { latencyMs: row.latencyMs } : {}),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}
