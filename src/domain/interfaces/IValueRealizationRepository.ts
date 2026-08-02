import type { SavingsMeasurementStatus } from './IRecommendationRepository.js';

export interface ValueRealizationFilters {
  readonly tenantId: string;
  readonly status?: SavingsMeasurementStatus | 'NO_EXECUTION';
  readonly currency?: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly severity?: string;
  readonly executedFrom?: Date;
  readonly executedTo?: Date;
  readonly verifiedFrom?: Date;
  readonly verifiedTo?: Date;
  readonly search?: string;
  readonly onlyIncreases?: boolean;
  readonly onlyPending?: boolean;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface ValueRealizationCurrencySummary {
  readonly currency: string;
  readonly estimatedMonthlySavings: number;
  readonly reportedMonthlySavings: number;
  readonly observedSavings: number;
  readonly projectedMonthlySavings: number;
  readonly verifiedMonthlySavings: number;
  readonly costIncreaseMonthlyAmount: number;
  readonly realizationRate: number;
  readonly varianceAgainstEstimate: number;
}

export interface ValueRealizationCounts {
  readonly identified: number;
  readonly approved: number;
  readonly executed: number;
  readonly withoutMeasurement: number;
  readonly waitingForData: number;
  readonly readyToCalculate: number;
  readonly calculatedPendingReview: number;
  readonly insufficientEvidence: number;
  readonly verified: number;
  readonly rejected: number;
}

export interface ValueRealizationSummary {
  readonly generatedAt: Date;
  readonly currencies: readonly ValueRealizationCurrencySummary[];
  readonly counts: ValueRealizationCounts;
}

export type ValueRealizationNextAction =
  | 'EXECUTE'
  | 'MEASURE'
  | 'WAIT_FOR_DATA'
  | 'REVIEW'
  | 'REVIEW_EVIDENCE'
  | 'RECALCULATE'
  | 'NONE';

export interface ValueRealizationItem {
  readonly recommendationId: string;
  readonly manualExecutionId?: string;
  readonly measurementId?: string;
  readonly title: string;
  readonly description: string;
  readonly recommendationStatus: string;
  readonly severity: string;
  readonly type: string;
  readonly cloudAccountId: string;
  readonly cloudAccountName: string;
  readonly provider: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly currency: string;
  readonly estimatedMonthlySavings: number;
  readonly reportedMonthlySavings: number;
  readonly observedSavings?: number;
  readonly projectedMonthlySavings?: number;
  readonly verifiedMonthlySavings: number;
  readonly costIncreaseMonthlyAmount: number;
  readonly varianceAgainstEstimate: number;
  readonly coverageRatio?: number;
  readonly confidenceLevel?: string;
  readonly billingSource?: string;
  readonly costBasis?: string;
  readonly measurementStatus?: SavingsMeasurementStatus | 'NO_EXECUTION';
  readonly executedAt?: Date;
  readonly observationEnd?: Date;
  readonly verifiedAt?: Date;
  readonly nextAction: ValueRealizationNextAction;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ValueRealizationItemsPage {
  readonly items: readonly ValueRealizationItem[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ValueRealizationTrendPoint {
  readonly period: string;
  readonly currency: string;
  readonly observedSavings: number;
  readonly verifiedMonthlySavings: number;
  readonly costIncreaseMonthlyAmount: number;
  readonly verifiedMeasurements: number;
}

export interface ValueRealizationReconciliationCandidate {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly manualExecutionId: string;
  readonly requestedByUserId: string;
  readonly executedAt: Date;
  readonly latestMeasurementId?: string;
}

export interface IValueRealizationRepository {
  getSummary(filters: ValueRealizationFilters): Promise<ValueRealizationSummary>;
  listItems(filters: ValueRealizationFilters): Promise<ValueRealizationItemsPage>;
  listItemsForExport(filters: ValueRealizationFilters): Promise<readonly ValueRealizationItem[]>;
  listTrend(filters: ValueRealizationFilters): Promise<readonly ValueRealizationTrendPoint[]>;
  listReconciliationCandidates(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<readonly ValueRealizationReconciliationCandidate[]>;
}
