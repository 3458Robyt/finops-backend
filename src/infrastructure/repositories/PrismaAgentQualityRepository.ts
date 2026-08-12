import type {
  AgentQualityPage,
  AgentQualityPageQuery,
  AgentQualityRecommendationRow,
  AgentQualityReportQuery,
  AgentQualityTraceRow,
  IAgentQualityRepository,
} from '../../domain/interfaces/IAgentQualityRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  listQualityRecommendationRows,
  listQualityTraceRows,
} from './queries/agentQualityQueries.js';

/** PostgreSQL adapter for tenant-scoped AI quality calibration data. */
export class PrismaAgentQualityRepository implements IAgentQualityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public listRecommendationRows(
    query: AgentQualityReportQuery,
    page: AgentQualityPageQuery,
  ): Promise<AgentQualityPage<AgentQualityRecommendationRow>> {
    return listQualityRecommendationRows(this.prisma, query, page);
  }

  public listTraceRows(
    query: AgentQualityReportQuery,
    page: AgentQualityPageQuery,
  ): Promise<AgentQualityPage<AgentQualityTraceRow>> {
    return listQualityTraceRows(this.prisma, query, page);
  }
}
