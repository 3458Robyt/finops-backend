import type { FinOpsRecommendation } from '../models/FinOpsRecommendation.js';
import type { RecommendationExecutionPlan } from '../models/RecommendationExecutionPlan.js';
import type {
  AdoptionKpis,
  CreateManualExecutionInput,
  CreateRecommendationDecisionInput,
  CreateRecommendationDecisionResult,
  CreateRecommendationExecutionPlanInput,
  CreateRecommendationInput,
  CreateSavingsMeasurementInput,
  RecommendationManualExecution,
  RecommendationQuery,
  RecommendationSavingsMeasurement,
  RecommendationTimelineEvent,
  RejectSavingsMeasurementInput,
  SavingsKpis,
  SavingsMeasurementReadiness,
  VerifySavingsMeasurementInput,
} from './IRecommendationRepository.js';

/** Lectura y creación del agregado base de recomendaciones. */
export interface IRecommendationCoreRepository {
  findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]>;
  findById(tenantId: string, recommendationId: string): Promise<FinOpsRecommendation | null>;
  createMany(input: readonly CreateRecommendationInput[]): Promise<FinOpsRecommendation[]>;
}

/** Operaciones del ciclo de vida humano y auditado de una recomendación. */
export interface IRecommendationLifecycleRepository {
  createExecutionPlan(input: CreateRecommendationExecutionPlanInput): Promise<RecommendationExecutionPlan>;
  findExecutionPlanById(
    tenantId: string,
    executionPlanId: string,
  ): Promise<RecommendationExecutionPlan | null>;
  findLatestExecutionPlanByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationExecutionPlan | null>;
  createDecision(input: CreateRecommendationDecisionInput): Promise<CreateRecommendationDecisionResult>;
  createManualExecution(input: CreateManualExecutionInput): Promise<RecommendationManualExecution>;
  findManualExecutionsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationManualExecution[]>;
  findTimelineByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationTimelineEvent[]>;
  getSavingsKpis(tenantId: string): Promise<SavingsKpis>;
  getAdoptionKpis(tenantId: string): Promise<AdoptionKpis>;
}

/** Operaciones de medición, verificación y rechazo del ahorro. */
export interface IRecommendationSavingsRepository {
  getSavingsMeasurementReadiness(
    tenantId: string,
    recommendationId: string,
  ): Promise<SavingsMeasurementReadiness>;
  createSavingsMeasurement(input: CreateSavingsMeasurementInput): Promise<RecommendationSavingsMeasurement>;
  findSavingsMeasurementsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationSavingsMeasurement[]>;
  findSavingsMeasurementById(
    tenantId: string,
    recommendationId: string,
    measurementId: string,
  ): Promise<RecommendationSavingsMeasurement | null>;
  verifySavingsMeasurement(input: VerifySavingsMeasurementInput): Promise<RecommendationSavingsMeasurement>;
  rejectSavingsMeasurement(input: RejectSavingsMeasurementInput): Promise<RecommendationSavingsMeasurement>;
}
