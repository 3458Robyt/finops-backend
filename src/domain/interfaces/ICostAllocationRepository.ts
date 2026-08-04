import type { AllocationCloudProvider, AllocationPreview, AllocationSummary, CostAllocationClosure, CostAllocationClosureComparison, CostAllocationMode, CostAllocationRule, CostAllocationRuleStatus, CostAllocationRuleTarget, UnallocatedCostDetail } from '../models/CostAllocation.js';

export interface CostAllocationRuleInput {
  readonly name: string;
  readonly description?: string;
  readonly priority: number;
  readonly status: CostAllocationRuleStatus;
  readonly allocationMode?: CostAllocationMode;
  readonly allocationTargets?: readonly CostAllocationRuleTarget[];
  readonly configurationVersion?: number;
  readonly configurationHash?: string;
  readonly cloudAccountId?: string;
  readonly provider?: AllocationCloudProvider;
  readonly serviceName?: string;
  readonly regionId?: string;
  readonly resourceId?: string;
  readonly tagKey?: string;
  readonly tagValue?: string;
  readonly costCenter?: string;
  readonly businessUnit?: string;
  readonly project?: string;
  readonly team?: string;
  readonly environment?: string;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date;
}

export interface ICostAllocationRepository {
  listRules(tenantId: string, status?: CostAllocationRuleStatus): Promise<readonly CostAllocationRule[]>;
  findRule(tenantId: string, ruleId: string): Promise<CostAllocationRule | null>;
  createRule(tenantId: string, userId: string, input: CostAllocationRuleInput): Promise<CostAllocationRule>;
  updateRule(tenantId: string, ruleId: string, input: Partial<CostAllocationRuleInput>): Promise<CostAllocationRule | null>;
  archiveRule(tenantId: string, ruleId: string, now: Date): Promise<CostAllocationRule | null>;
  summarize(tenantId: string, periodStart: Date, cloudAccountId?: string, serviceName?: string, allocationKey?: string): Promise<readonly AllocationSummary[]>;
  preview(tenantId: string, input: CostAllocationRuleInput, periodStart: Date): Promise<AllocationPreview>;
  resourceSummary(tenantId: string, resourceId: string, cloudResourceId?: string): Promise<readonly AllocationSummary[]>;
  unallocated(tenantId: string, periodStart: Date, currency?: string, cloudAccountId?: string, serviceName?: string): Promise<readonly UnallocatedCostDetail[]>;
  closePeriod(tenantId: string, userId: string, periodStart: Date, confirmUnallocated: boolean, replacementReason?: string): Promise<readonly CostAllocationClosure[]>;
  listClosures(tenantId: string, period?: Date): Promise<readonly CostAllocationClosure[]>;
  getClosure(tenantId: string, closureId: string): Promise<CostAllocationClosure | null>;
  compareClosures(tenantId: string, closureId: string): Promise<CostAllocationClosureComparison | null>;
  writeAudit(tenantId: string, userId: string, action: string, ruleId: string, metadata: unknown): Promise<void>;
}
