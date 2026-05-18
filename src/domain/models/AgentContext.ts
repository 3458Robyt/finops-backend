import type { UserRole } from './AuthContext.js';

export type AgentInstructionProfileStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED';
export type TenantAgentRuleStatus = 'ACTIVE' | 'DISABLED';
export type AiContextOperation = 'CHAT' | 'RECOMMENDATION' | 'EXECUTION_PLAN' | 'AUDIT' | 'LEARNING';
export type ContextBuildRunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface AgentInstructionRules {
  readonly objective: string;
  readonly tone: string;
  readonly recommendationPriorities: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly riskPolicy: string;
  readonly forbiddenActions: readonly string[];
}

export interface AgentInstructionProfile {
  readonly id: string;
  readonly version: number;
  readonly status: AgentInstructionProfileStatus;
  readonly structuredRules: AgentInstructionRules;
  readonly freeformNotes?: string | undefined;
  readonly validationReport?: AgentInstructionValidationReport | undefined;
  readonly activatedAt?: Date | undefined;
  readonly createdByUserId: string;
  readonly activatedByUserId?: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentInstructionValidationReport {
  readonly passed: boolean;
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
}

export interface TenantAgentRule {
  readonly id: string;
  readonly tenantId: string;
  readonly category: string;
  readonly ruleText: string;
  readonly priority: number;
  readonly status: TenantAgentRuleStatus;
  readonly disabledAt?: Date | undefined;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ContextArtifact {
  readonly id: string;
  readonly artifactType: string;
  readonly scopeKey: string;
  readonly summary: string;
  readonly tokenEstimate: number;
  readonly provider?: string | undefined;
  readonly cloudAccountId?: string | undefined;
  readonly serviceName?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly evidenceRefs?: unknown | undefined;
}

export interface AiContextTrace {
  readonly id: string;
  readonly tenantId: string;
  readonly userId?: string | undefined;
  readonly operation: AiContextOperation;
  readonly model: string;
  readonly status: string;
  readonly profileVersion?: number | undefined;
  readonly promptTokenEstimate: number;
  readonly responseTokenEstimate?: number | undefined;
  readonly latencyMs?: number | undefined;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface KnowledgeGraphNode {
  readonly id: string;
  readonly nodeType: string;
  readonly label: string;
  readonly externalId?: string | undefined;
  readonly metadata?: unknown | undefined;
}

export interface KnowledgeGraphEdge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly relationType: string;
  readonly confidence: number;
  readonly metadata?: unknown | undefined;
}

export interface KnowledgeGraphContext {
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
}

export const agentAdminRoles: readonly UserRole[] = ['ADMIN', 'OPERATOR_ADMIN'];
export const agentTechnicalRoles: readonly UserRole[] = ['ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN'];
