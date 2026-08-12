import type {
  AdoptionKpis,
  CreateRecommendationDecisionInput,
  CreateRecommendationDecisionResult,
  CreateRecommendationExecutionPlanInput,
  CreateRecommendationInput,
  CreateManualExecutionInput,
  IRecommendationRepository,
  RecommendationManualExecution,
  RecommendationQuery,
  RecommendationSavingsMeasurement,
  RecommendationTimelineEvent,
  SavingsKpis,
  SavingsMeasurementReadiness,
  CreateSavingsMeasurementInput,
  VerifySavingsMeasurementInput,
  RejectSavingsMeasurementInput,
} from "../../domain/interfaces/IRecommendationRepository.js";
import type { FinOpsRecommendation } from "../../domain/models/FinOpsRecommendation.js";
import type { RecommendationExecutionPlan } from "../../domain/models/RecommendationExecutionPlan.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaRecommendationLifecycleRepository } from "./PrismaRecommendationLifecycleRepository.js";
import { PrismaRecommendationSavingsRepository } from "./PrismaRecommendationSavingsRepository.js";
import { PrismaRecommendationTimelineRepository } from "./PrismaRecommendationTimelineRepository.js";

/** Stable facade preserving the recommendation repository domain port. */
export class PrismaRecommendationRepository implements IRecommendationRepository {
  private readonly lifecycle: PrismaRecommendationLifecycleRepository;
  private readonly savings: PrismaRecommendationSavingsRepository;
  private readonly timeline: PrismaRecommendationTimelineRepository;

  constructor(prisma: PrismaClient) {
    this.lifecycle = new PrismaRecommendationLifecycleRepository(prisma);
    this.savings = new PrismaRecommendationSavingsRepository(prisma);
    this.timeline = new PrismaRecommendationTimelineRepository(prisma);
  }

  public findById(
    tenantId: string,
    recommendationId: string,
  ): Promise<FinOpsRecommendation | null> {
    return this.lifecycle.findById(tenantId, recommendationId);
  }
  public findByTenant(
    query: RecommendationQuery,
  ): Promise<FinOpsRecommendation[]> {
    return this.lifecycle.findByTenant(query);
  }
  public createMany(
    input: readonly CreateRecommendationInput[],
  ): Promise<FinOpsRecommendation[]> {
    return this.lifecycle.createMany(input);
  }
  public createExecutionPlan(
    input: CreateRecommendationExecutionPlanInput,
  ): Promise<RecommendationExecutionPlan> {
    return this.lifecycle.createExecutionPlan(input);
  }
  public findExecutionPlanById(
    tenantId: string,
    executionPlanId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    return this.lifecycle.findExecutionPlanById(tenantId, executionPlanId);
  }
  public findLatestExecutionPlanByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    return this.lifecycle.findLatestExecutionPlanByRecommendation(
      tenantId,
      recommendationId,
    );
  }
  public createDecision(
    input: CreateRecommendationDecisionInput,
  ): Promise<CreateRecommendationDecisionResult> {
    return this.lifecycle.createDecision(input);
  }
  public createManualExecution(
    input: CreateManualExecutionInput,
  ): Promise<RecommendationManualExecution> {
    return this.lifecycle.createManualExecution(input);
  }
  public findManualExecutionsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationManualExecution[]> {
    return this.lifecycle.findManualExecutionsByRecommendation(
      tenantId,
      recommendationId,
    );
  }
  public findTimelineByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationTimelineEvent[]> {
    return this.timeline.findTimelineByRecommendation(
      tenantId,
      recommendationId,
    );
  }
  public getSavingsKpis(tenantId: string): Promise<SavingsKpis> {
    return this.savings.getSavingsKpis(tenantId);
  }
  public getAdoptionKpis(tenantId: string): Promise<AdoptionKpis> {
    return this.savings.getAdoptionKpis(tenantId);
  }
  public getSavingsMeasurementReadiness(
    tenantId: string,
    recommendationId: string,
  ): Promise<SavingsMeasurementReadiness> {
    return this.savings.getSavingsMeasurementReadiness(
      tenantId,
      recommendationId,
    );
  }
  public createSavingsMeasurement(
    input: CreateSavingsMeasurementInput,
  ): Promise<RecommendationSavingsMeasurement> {
    return this.savings.createSavingsMeasurement(input);
  }
  public findSavingsMeasurementsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationSavingsMeasurement[]> {
    return this.savings.findSavingsMeasurementsByRecommendation(
      tenantId,
      recommendationId,
    );
  }
  public findSavingsMeasurementById(
    tenantId: string,
    recommendationId: string,
    measurementId: string,
  ): Promise<RecommendationSavingsMeasurement | null> {
    return this.savings.findSavingsMeasurementById(
      tenantId,
      recommendationId,
      measurementId,
    );
  }
  public verifySavingsMeasurement(
    input: VerifySavingsMeasurementInput,
  ): Promise<RecommendationSavingsMeasurement> {
    return this.savings.verifySavingsMeasurement(input);
  }
  public rejectSavingsMeasurement(
    input: RejectSavingsMeasurementInput,
  ): Promise<RecommendationSavingsMeasurement> {
    return this.savings.rejectSavingsMeasurement(input);
  }
}
