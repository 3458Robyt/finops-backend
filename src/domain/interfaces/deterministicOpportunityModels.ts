import type { ResourceEvidenceStatus, ResourceFreshnessStatus } from '../models/ResourceLinkage.js';

export const deterministicOpportunityRuleVersion = 'finops-opportunity-rules-v1';

export type DeterministicOpportunityKind =
  | 'DATA_LINKAGE'
  | 'DATA_FRESHNESS'
  | 'TECHNICAL_EVIDENCE'
  | 'TAG_GOVERNANCE';

export type DeterministicOpportunityPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type DeterministicOpportunityStatus = 'OPEN' | 'BLOCKED' | 'INFORMATIONAL';
export type DeterministicSignalValue = boolean | number | string | null;

export interface DeterministicOpportunitySignal {
  readonly key: string;
  readonly value: DeterministicSignalValue;
}

export interface DeterministicOpportunityEvidence {
  readonly source: 'RESOURCE_LINKAGE_READINESS';
  readonly ruleVersion: string;
  readonly signals: readonly DeterministicOpportunitySignal[];
}

export interface DeterministicFinOpsOpportunity {
  readonly id: string;
  readonly kind: DeterministicOpportunityKind;
  readonly priority: DeterministicOpportunityPriority;
  readonly status: DeterministicOpportunityStatus;
  readonly title: string;
  readonly description: string;
  readonly recommendedAction: string;
  readonly resourceId?: string;
  readonly externalResourceId?: string;
  readonly serviceName?: string;
  readonly evidenceStatus?: ResourceEvidenceStatus;
  readonly evidence: DeterministicOpportunityEvidence;
}

export interface DeterministicOpportunityCatalog {
  readonly generatedAt: Date;
  readonly ruleVersion: string;
  readonly inventoryResources: number;
  readonly sampledResources: number;
  readonly resourceCoverageComplete: boolean;
  readonly opportunities: readonly DeterministicFinOpsOpportunity[];
}
