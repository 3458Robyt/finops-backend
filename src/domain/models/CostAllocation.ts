export type CostAllocationRuleStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type AllocationCloudProvider = 'AWS' | 'OCI' | 'AZURE' | 'GCP' | 'CUSTOM';

export interface CostAllocationTarget {
  readonly costCenter?: string;
  readonly businessUnit?: string;
  readonly project?: string;
  readonly team?: string;
  readonly environment?: string;
}

export interface CostAllocationRule extends CostAllocationTarget {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly priority: number;
  readonly status: CostAllocationRuleStatus;
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
}

export interface AllocationSummary {
  readonly period: string;
  readonly currency: string;
  readonly totalCost: number;
  readonly allocatedCost: number;
  readonly unallocatedCost: number;
  readonly coveragePercent: number;
  readonly dimensions: readonly AllocationBreakdown[];
}

export interface AllocationPreview {
  readonly summary: readonly AllocationSummary[];
  readonly metricCount: number;
  readonly resourceCount: number;
  readonly examples: readonly { readonly currency: string; readonly cost: number; readonly cloudAccountId: string; readonly serviceName: string; readonly resourceId?: string }[];
}

export interface UnallocatedCostDetail {
  readonly currency: string;
  readonly cost: number;
  readonly metricCount: number;
  readonly resourceId?: string;
  readonly serviceName: string;
  readonly cloudAccountId: string;
  readonly suggestedCriteria: readonly string[];
}
