import type { RecommendationTimelineEvent } from "../../domain/interfaces/IRecommendationRepository.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { buildRecommendationTimeline } from "./queries/recommendationTimelineBuilder.js";

/** Builds the tenant-scoped recommendation audit timeline. */
export class PrismaRecommendationTimelineRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findTimelineByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationTimelineEvent[]> {
    const recommendation = await this.prisma.recommendation.findFirst({
      where: { tenantId, id: recommendationId },
    });

    if (recommendation === null) return [];

    const [plans, decisions, executions, measurements, learningEvents] =
      await Promise.all([
        this.prisma.recommendationExecutionPlan.findMany({
          where: { recommendationId },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.recommendationDecision.findMany({
          where: { recommendationId },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.recommendationManualExecution.findMany({
          where: { tenantId, recommendationId },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.recommendationSavingsMeasurement.findMany({
          where: { tenantId, recommendationId },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.agentLearningEvent.findMany({
          where: { tenantId, recommendationId },
          orderBy: { createdAt: "asc" },
        }),
      ]);

    return buildRecommendationTimeline(
      recommendation,
      plans,
      decisions,
      executions,
      measurements,
      learningEvents,
    );
  }
}
