import type { FinOpsRecommendation } from '../models/FinOpsRecommendation.js';

export interface RecommendationQuery {
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly status?: FinOpsRecommendation['status'];
}

export interface IRecommendationRepository {
  findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]>;
}
