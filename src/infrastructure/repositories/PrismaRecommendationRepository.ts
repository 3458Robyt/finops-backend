import type { IRecommendationRepository, RecommendationQuery } from '../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

export class PrismaRecommendationRepository implements IRecommendationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: {
        tenantId: query.tenantId,
        ...(query.cloudAccountId !== undefined ? { cloudAccountId: query.cloudAccountId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      orderBy: [
        { createdAt: 'desc' },
      ],
    });

    return rows.map((row) => ({
      id: row.id,
      cloudAccountId: row.cloudAccountId,
      type: row.type,
      status: row.status,
      severity: row.severity,
      title: row.title,
      description: row.description,
      evidence: row.evidence,
      ...(row.estimatedMonthlySavings !== null
        ? { estimatedMonthlySavings: Number(row.estimatedMonthlySavings) }
        : {}),
      currency: row.currency,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}
