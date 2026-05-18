import type {
  AgentInstructionProfile,
  AgentInstructionRules,
  AgentInstructionValidationReport,
  AiContextOperation,
  AiContextTrace,
  ContextArtifact,
  ContextBuildRunStatus,
  KnowledgeGraphContext,
  TenantAgentRule,
} from '../models/AgentContext.js';
import type { AgentMemoryScope } from '../models/AgentLearning.js';

export interface ActivateAgentProfileInput {
  readonly actorUserId: string;
  readonly structuredRules: AgentInstructionRules;
  readonly freeformNotes?: string;
  readonly validationReport: AgentInstructionValidationReport;
}

export interface CreateTenantAgentRuleInput {
  readonly tenantId: string;
  readonly category: string;
  readonly ruleText: string;
  readonly priority: number;
  readonly createdByUserId: string;
}

export interface UpsertContextSummaryInput {
  readonly tenantId: string;
  readonly artifactType: string;
  readonly scopeKey: string;
  readonly sourceHash: string;
  readonly summary: string;
  readonly tokenEstimate: number;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly facts?: unknown;
  readonly evidenceRefs?: unknown;
}

export interface CreateAiContextTraceInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly operation: AiContextOperation;
  readonly model: string;
  readonly status: string;
  readonly profileVersion?: number;
  readonly promptTokenEstimate: number;
  readonly responseTokenEstimate?: number;
  readonly latencyMs?: number;
  readonly artifactIds?: readonly string[];
  readonly memoryIds?: readonly string[];
  readonly knowledgeNodeIds?: readonly string[];
  readonly tenantRuleIds?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly errorMessage?: string;
}

export interface CreateContextBuildRunInput {
  readonly tenantId: string;
  readonly runType: string;
  readonly createdByUserId?: string;
  readonly metadata?: unknown;
}

export interface CompleteContextBuildRunInput {
  readonly runId: string;
  readonly status: Extract<ContextBuildRunStatus, 'SUCCESS' | 'FAILED'>;
  readonly errorMessage?: string;
  readonly metadata?: unknown;
}

export interface UpsertKnowledgeNodeInput {
  readonly tenantId: string;
  readonly scope: AgentMemoryScope;
  readonly nodeType: string;
  readonly dedupeKey: string;
  readonly externalId?: string;
  readonly label: string;
  readonly metadata?: unknown;
}

export interface UpsertKnowledgeEdgeInput {
  readonly tenantId: string;
  readonly scope: AgentMemoryScope;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly relationType: string;
  readonly dedupeKey: string;
  readonly confidence: number;
  readonly metadata?: unknown;
}

export interface FocusResourcePeriodAggregate {
  readonly tenantId: string;
  readonly provider: string;
  readonly cloudAccountId: string;
  readonly serviceName: string;
  readonly resourceId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly billedCost: number;
  readonly consumedQuantity?: number;
  readonly consumedUnit?: string;
  readonly currency: string;
  readonly metricCount: number;
}

export interface IAgentContextRepository {
  findActiveProfile(): Promise<AgentInstructionProfile | null>;
  activateProfile(input: ActivateAgentProfileInput): Promise<AgentInstructionProfile>;
  listTenantRules(tenantId: string): Promise<TenantAgentRule[]>;
  createTenantRule(input: CreateTenantAgentRuleInput): Promise<TenantAgentRule>;
  disableTenantRule(tenantId: string, ruleId: string): Promise<TenantAgentRule | null>;
  createInstructionAuditEvent(input: {
    readonly tenantId?: string;
    readonly actorUserId?: string;
    readonly action: string;
    readonly entityType: string;
    readonly entityId?: string;
    readonly metadata?: unknown;
  }): Promise<void>;
  findContextSummaries(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<ContextArtifact[]>;
  upsertContextSummary(input: UpsertContextSummaryInput): Promise<ContextArtifact>;
  createAiContextTrace(input: CreateAiContextTraceInput): Promise<AiContextTrace>;
  listAiContextTraces(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<AiContextTrace[]>;
  createContextBuildRun(input: CreateContextBuildRunInput): Promise<string>;
  completeContextBuildRun(input: CompleteContextBuildRunInput): Promise<void>;
  listFocusResourcePeriodAggregates(tenantId: string): Promise<FocusResourcePeriodAggregate[]>;
  upsertKnowledgeNode(input: UpsertKnowledgeNodeInput): Promise<string>;
  upsertKnowledgeEdge(input: UpsertKnowledgeEdgeInput): Promise<string>;
  getKnowledgeGraph(input: {
    readonly tenantId: string;
    readonly recommendationId?: string;
    readonly resourceId?: string;
    readonly depth: number;
  }): Promise<KnowledgeGraphContext>;
}
