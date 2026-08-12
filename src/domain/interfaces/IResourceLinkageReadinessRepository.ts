import type {
  ResourceEvidenceStatus,
  ResourceFreshness,
  ResourceLinkReasonCode,
} from '../models/ResourceLinkage.js';
import type { DeterministicOpportunityCatalog } from './deterministicOpportunityModels.js';


export type CostResourceClassification =
  | 'RESOURCE_FOUND'
  | 'HISTORICAL_RESOURCE'
  | 'SERVICE_OR_ACCOUNT_LEVEL'
  | 'CONNECTION_NOT_AVAILABLE'
  | 'INVALID_OR_UNSUPPORTED_ID'
  | 'INVENTORY_RESOURCE_NOT_FOUND'
  | 'AMBIGUOUS_RESOURCE_ID';

export interface CostResourceClassificationSummary {
  readonly counts: Readonly<Record<CostResourceClassification, number>>;
  readonly byService: readonly {
    readonly serviceName: string;
    readonly total: number;
    readonly eligible: number;
    readonly linked: number;
    readonly coveragePercent: number;
    readonly counts: Readonly<Record<CostResourceClassification, number>>;
  }[];
}

export type ResourceLinkageCoverageStatus =
  | 'COST_AND_TECHNICAL'
  | 'COST_ONLY'
  | 'TECHNICAL_ONLY'
  | 'INVENTORY_ONLY';

export interface ResourceLinkageTableCoverage {
  readonly total: number;
  readonly eligible: number;
  readonly linked: number;
  readonly notEligible: number;
  readonly unresolved: number;
  readonly ambiguous: number;
  readonly coveragePercent: number;
  readonly reasons: Readonly<Partial<Record<ResourceLinkReasonCode, number>>>;
}

export interface ResourceLinkageResourceCoverage {
  readonly id: string;
  readonly cloudConnectionId: string;
  readonly externalResourceId: string;
  readonly provider: string;
  readonly serviceName: string;
  readonly resourceType: string;
  readonly status: string;
  readonly costMetrics: number;
  readonly metricSamples: number;
  readonly recommendations: number;
  readonly coverage: ResourceLinkageCoverageStatus;
  readonly evidenceStatus: ResourceEvidenceStatus;
  readonly freshness: ResourceFreshness;
  readonly latestCostAt?: Date;
  readonly latestMetricAt?: Date;
}

export interface ResourceLinkageConnectionReadiness {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly inventoryResources: number;
  readonly costs: ResourceLinkageTableCoverage;
  readonly costClassifications: CostResourceClassificationSummary;
  readonly metrics: ResourceLinkageTableCoverage;
  readonly recommendations: ResourceLinkageTableCoverage;
  readonly freshness: ResourceFreshness;
  readonly status: 'READY' | 'PARTIAL' | 'BLOCKED' | 'NO_DATA';
}

export interface ResourceTagGovernance {
  readonly requiredKeys: readonly string[];
  readonly totalResources: number;
  readonly taggedResources: number;
  readonly compliantResources: number;
  readonly nonCompliantResources: number;
  readonly untaggedResources: number;
  readonly coveragePercent: number;
  readonly missingKeys: Readonly<Record<string, number>>;
}

export interface ResourceLinkageReadiness {
  readonly generatedAt: Date;
  readonly status: 'READY' | 'PARTIAL' | 'BLOCKED' | 'NO_DATA';
  readonly inventoryResources: number;
  readonly linkedResourcesWithCost: number;
  readonly linkedResourcesWithMetrics: number;
  readonly linkedResourcesWithBoth: number;
  readonly costs: ResourceLinkageTableCoverage;
  readonly costClassifications: CostResourceClassificationSummary;
  readonly metrics: ResourceLinkageTableCoverage;
  readonly recommendations: ResourceLinkageTableCoverage;
  readonly resources: readonly ResourceLinkageResourceCoverage[];
  readonly connections: readonly ResourceLinkageConnectionReadiness[];
  readonly tagGovernance: ResourceTagGovernance;
  readonly freshness: ResourceFreshness;
  readonly technicalRecommendationBlockers: readonly string[];
  /** Added by the application service; repositories may omit it. */
  readonly opportunityCatalog?: DeterministicOpportunityCatalog;
  readonly latestReconciliation?: {
    readonly observedAt: Date;
    readonly status: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export interface IResourceLinkageReadinessRepository {
  getForTenant(tenantId: string, resourceLimit: number): Promise<ResourceLinkageReadiness>;
}
