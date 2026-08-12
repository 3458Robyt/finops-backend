import type { FinOpsAiService } from "../../application/services/FinOpsAiService.js";
import type { IAgentLearningService } from "../../domain/interfaces/IAgentLearningService.js";
import type { IRecommendationRepository } from "../../domain/interfaces/IRecommendationRepository.js";
import type { ValueRealizationService } from "../../application/services/ValueRealizationService.js";
import { RecommendationExecutionController } from "./RecommendationExecutionController.js";
import { RecommendationReadController } from "./RecommendationReadController.js";
import { RecommendationSavingsController } from "./RecommendationSavingsController.js";

/** Stable facade for recommendation HTTP handlers, grouped by capability. */
export class RecommendationController {
  public readonly createExecutionPlan: RecommendationExecutionController["createExecutionPlan"];
  public readonly getLatestExecutionPlan: RecommendationExecutionController["getLatestExecutionPlan"];
  public readonly createManualExecution: RecommendationExecutionController["createManualExecution"];
  public readonly getTimeline: RecommendationExecutionController["getTimeline"];
  public readonly createDecision: RecommendationExecutionController["createDecision"];
  public readonly getSavingsMeasurementReadiness: RecommendationSavingsController["getSavingsMeasurementReadiness"];
  public readonly createSavingsMeasurement: RecommendationSavingsController["createSavingsMeasurement"];
  public readonly listSavingsMeasurements: RecommendationSavingsController["listSavingsMeasurements"];
  public readonly getSavingsMeasurement: RecommendationSavingsController["getSavingsMeasurement"];
  public readonly verifySavingsMeasurement: RecommendationSavingsController["verifySavingsMeasurement"];
  public readonly rejectSavingsMeasurement: RecommendationSavingsController["rejectSavingsMeasurement"];
  public readonly getRecommendationById: RecommendationReadController["getRecommendationById"];
  public readonly getRecommendations: RecommendationReadController["getRecommendations"];

  constructor(
    recommendationRepository: IRecommendationRepository,
    aiService?: FinOpsAiService,
    learningService?: IAgentLearningService,
    valueRealizationService?: ValueRealizationService,
  ) {
    const execution = new RecommendationExecutionController(
      recommendationRepository,
      aiService,
      learningService,
    );
    const savings = new RecommendationSavingsController(
      recommendationRepository,
      valueRealizationService,
    );
    const read = new RecommendationReadController(recommendationRepository);
    this.createExecutionPlan = execution.createExecutionPlan;
    this.getLatestExecutionPlan = execution.getLatestExecutionPlan;
    this.createManualExecution = execution.createManualExecution;
    this.getTimeline = execution.getTimeline;
    this.createDecision = execution.createDecision;
    this.getSavingsMeasurementReadiness =
      savings.getSavingsMeasurementReadiness;
    this.createSavingsMeasurement = savings.createSavingsMeasurement;
    this.listSavingsMeasurements = savings.listSavingsMeasurements;
    this.getSavingsMeasurement = savings.getSavingsMeasurement;
    this.verifySavingsMeasurement = savings.verifySavingsMeasurement;
    this.rejectSavingsMeasurement = savings.rejectSavingsMeasurement;
    this.getRecommendationById = read.getRecommendationById;
    this.getRecommendations = read.getRecommendations;
  }
}
