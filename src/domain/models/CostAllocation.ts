export type CostAllocationRuleStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type CostAllocationMode = 'DIRECT' | 'SPLIT';
export type CostAllocationClosureStatus = 'CLOSED' | 'REPLACED';
export type AllocationCloudProvider = 'AWS' | 'OCI' | 'AZURE' | 'GCP' | 'CUSTOM';

export interface CostAllocationTarget {
  readonly costCenter?: string;
  readonly businessUnit?: string;
  readonly project?: string;
  readonly team?: string;
  readonly environment?: string;
}

export interface CostAllocationRuleTarget extends CostAllocationTarget {
  readonly percentage: number;
  readonly id?: string;
}

export interface CostAllocationRule extends CostAllocationTarget {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly priority: number;
  readonly status: CostAllocationRuleStatus;
  readonly allocationMode: CostAllocationMode;
  readonly allocationTargets: readonly CostAllocationRuleTarget[];
  readonly configurationVersion: number;
  readonly configurationHash?: string;
  readonly lastPreviewedHash?: string;
  readonly lastPreviewedAt?: Date;
  readonly cloudAccountId?: string;
  readonly provider?: AllocationCloudProvider;
  readonly serviceName?: string;
  readonly regionId?: string;
  readonly resourceId?: string;
  readonly tagKey?: string;
  readonly tagValue?: string;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date;
  readonly createdByUserId: string;
  readonly archivedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AllocationBreakdown extends CostAllocationTarget {
  readonly allocationKey: string;
  readonly currency: string;
  readonly cost: number;
  readonly metricCount: number;
  readonly resourceCount: number;
  readonly percentage?: number;
  readonly ruleId?: string;
  readonly shared: boolean;
}

export interface AllocationSummary {
  readonly period: string;
  readonly currency: string;
  readonly totalCost: number;
  readonly allocatedCost: number;
  readonly unallocatedCost: number;
  readonly sharedCost: number;
  readonly coveragePercent: number;
  readonly dimensions: readonly AllocationBreakdown[];
}

export interface AllocationPreview {
  readonly summary: readonly AllocationSummary[];
  readonly previousSummary: readonly AllocationSummary[];
  readonly rulesUsed: readonly { readonly id: string; readonly name: string; readonly allocationMode: CostAllocationMode; readonly configurationVersion: number }[];
  readonly metricCount: number;
  readonly resourceCount: number;
  readonly examples: readonly { readonly currency: string; readonly cost: number; readonly cloudAccountId: string; readonly serviceName: string; readonly resourceId?: string }[];
  readonly financialImpact: AllocationFinancialImpact;
}

export interface AllocationFinancialImpact {
  readonly budgets: readonly { readonly allocationKey: string; readonly currency: string; readonly budgetAmount: number; readonly projectedCost: number; readonly remainingBudget: number; readonly consumedPercent: number }[];
  readonly savings: readonly { readonly allocationKey: string; readonly currency: string; readonly potentialSavings: number; readonly approvedSavings: number; readonly verifiedSavings: number; readonly observedSavings: number; readonly attributedRecommendations: number }[];
}

export interface CostAllocationClosure {
  readonly id: string;
  readonly tenantId: string;
  readonly period: string;
  readonly currency: string;
  readonly version: number;
  readonly status: CostAllocationClosureStatus;
  readonly sourceTotal: number;
  readonly allocatedTotal: number;
  readonly sharedTotal: number;
  readonly unallocatedTotal: number;
  readonly sourceHash: string;
  readonly rulesHash: string;
  readonly results: readonly AllocationBreakdown[];
  readonly replacementReason?: string;
  readonly closedByUserId: string;
  readonly createdAt: Date;
}

export interface CostAllocationClosureComparison {
  readonly current: CostAllocationClosure;
  readonly previous?: CostAllocationClosure;
}

export interface UnallocatedCostDetail {
  readonly currency: string;
  readonly cost: number;
  readonly metricCount: number;
  readonly resourceId?: string;
  readonly cloudResourceId?: string;
  readonly serviceName: string;
  readonly cloudAccountId: string;
  readonly suggestedCriteria: readonly string[];
}
